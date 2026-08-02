"""Provider-agnostic chat client for the AI Advisor tool-calling flow.

  messages:
    {"role": "system" | "user", "content": str}
    {"role": "assistant", "content": str | None, "tool_calls": [{"id", "name", "arguments": dict}]}
    {"role": "assistant", "content": str}                       # final answer, no tool call
    {"role": "tool", "tool_call_id": str, "name": str, "content": str}   # content is a JSON string

  tools:
    {"name": str, "description": str, "parameters": <JSON schema object>}

Add a new provider by implementing chat() and registering it in get_ai_provider().
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from loguru import logger


class AIProviderError(Exception):
    """Raised when the configured AI provider is unavailable or a request to it fails."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: Dict[str, Any]


@dataclass
class ChatResult:
    content: str
    tool_calls: List[ToolCall] = field(default_factory=list)


def _http_post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout: int = 25) -> Dict[str, Any]:
    req = urllib.request.Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
        parsed: Any = json.loads(body)
        return parsed if isinstance(parsed, dict) else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore") if hasattr(e, "read") else str(e)
        logger.error(f"AI provider HTTP error: {e.code} {detail}")
        raise AIProviderError("AI provider request failed", status_code=502)
    except AIProviderError:
        raise
    except Exception as e:
        logger.error(f"AI provider error: {str(e)}")
        raise AIProviderError("AI provider request failed", status_code=502)


class ChatProvider:
    name: str = "base"
    model: str = ""

    def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None) -> ChatResult:
        raise NotImplementedError


class OpenAICompatibleProvider(ChatProvider):
    """Works for any provider implementing the OpenAI Chat Completions wire format.

    Used for both OpenAI itself and xAI's Grok API, which mirrors the same
    request/response shape at a different base URL.
    """

    def __init__(self, name: str, api_key: str, model: str, base_url: str):
        self.name = name
        self.api_key = api_key
        self.model = model
        self.base_url = base_url

    def _to_wire_messages(self, messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        wire: List[Dict[str, Any]] = []
        for m in messages:
            role = m["role"]
            if role == "tool":
                wire.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"]})
            elif role == "assistant" and m.get("tool_calls"):
                wire.append({
                    "role": "assistant",
                    "content": m.get("content"),
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"], ensure_ascii=False)},
                        }
                        for tc in m["tool_calls"]
                    ],
                })
            else:
                wire.append({"role": role, "content": m.get("content")})
        return wire

    def _to_wire_tools(self, tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}}
            for t in tools
        ]

    def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None) -> ChatResult:
        if not self.api_key:
            raise AIProviderError(f"{self.name} API key is not configured. See .env.example.", status_code=503)

        payload: Dict[str, Any] = {"model": self.model, "temperature": 0.2, "messages": self._to_wire_messages(messages)}
        if tools:
            payload["tools"] = self._to_wire_tools(tools)
            payload["tool_choice"] = "auto"

        data = _http_post_json(
            url=self.base_url,
            payload=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
        )

        choices = data.get("choices") or []
        if not choices:
            raise AIProviderError(f"{self.name} response did not include any choices")

        message = choices[0].get("message") or {}
        content = str(message.get("content") or "")

        tool_calls: List[ToolCall] = []
        for tc in message.get("tool_calls") or []:
            function = tc.get("function") or {}
            try:
                args = json.loads(function.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(ToolCall(id=tc.get("id", ""), name=function.get("name", ""), arguments=args))

        return ChatResult(content=content, tool_calls=tool_calls)


class GeminiProvider(ChatProvider):
    """Google Gemini's generateContent REST API."""

    def __init__(self, api_key: str, model: str):
        self.name = "Gemini"
        self.api_key = api_key
        self.model = model

    def _split_system_and_turns(self, messages: List[Dict[str, Any]]) -> tuple[str, List[Dict[str, Any]]]:
        system_parts: List[str] = []
        turns: List[Dict[str, Any]] = []
        for m in messages:
            role = m["role"]
            if role == "system":
                system_parts.append(m.get("content") or "")
            elif role == "user":
                turns.append({"role": "user", "parts": [{"text": m.get("content") or ""}]})
            elif role == "assistant":
                if m.get("tool_calls"):
                    parts: List[Dict[str, Any]] = []
                    if m.get("content"):
                        parts.append({"text": m["content"]})
                    for tc in m["tool_calls"]:
                        parts.append({"functionCall": {"name": tc["name"], "args": tc["arguments"]}})
                    turns.append({"role": "model", "parts": parts})
                else:
                    turns.append({"role": "model", "parts": [{"text": m.get("content") or ""}]})
            elif role == "tool":
                try:
                    response_obj = json.loads(m["content"])
                except json.JSONDecodeError:
                    response_obj = {"result": m["content"]}
                if not isinstance(response_obj, dict):
                    response_obj = {"result": response_obj}
                turns.append({
                    "role": "user",
                    "parts": [{"functionResponse": {"name": m.get("name", ""), "response": response_obj}}],
                })
        return "\n".join(p for p in system_parts if p), turns

    def _to_wire_tools(self, tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [{
            "function_declarations": [
                {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}
                for t in tools
            ]
        }]

    def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None) -> ChatResult:
        if not self.api_key:
            raise AIProviderError("Gemini API key is not configured. See .env.example.", status_code=503)

        system_text, contents = self._split_system_and_turns(messages)
        payload: Dict[str, Any] = {"contents": contents, "generationConfig": {"temperature": 0.2}}
        if system_text:
            payload["system_instruction"] = {"parts": [{"text": system_text}]}
        if tools:
            payload["tools"] = self._to_wire_tools(tools)
            payload["tool_config"] = {"function_calling_config": {"mode": "AUTO"}}

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={self.api_key}"
        data = _http_post_json(url=url, payload=payload, headers={"Content-Type": "application/json"})

        candidates = data.get("candidates") or []
        if not candidates:
            block_reason = (data.get("promptFeedback") or {}).get("blockReason")
            suffix = f" (blocked: {block_reason})" if block_reason else ""
            raise AIProviderError(f"Gemini response did not include any candidates{suffix}")

        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        text_chunks = [p["text"] for p in parts if "text" in p]

        tool_calls: List[ToolCall] = []
        for i, p in enumerate(parts):
            if "functionCall" in p:
                fc = p["functionCall"]
                tool_calls.append(ToolCall(id=f"call_{i}", name=fc.get("name", ""), arguments=fc.get("args") or {}))

        return ChatResult(content="\n".join(text_chunks).strip(), tool_calls=tool_calls)


class ClaudeProvider(ChatProvider):
    """Anthropic's Messages API."""

    def __init__(self, api_key: str, model: str):
        self.name = "Claude"
        self.api_key = api_key
        self.model = model

    def _split_system_and_turns(self, messages: List[Dict[str, Any]]) -> tuple[str, List[Dict[str, Any]]]:
        system_parts: List[str] = []
        turns: List[Dict[str, Any]] = []
        for m in messages:
            role = m["role"]
            if role == "system":
                system_parts.append(m.get("content") or "")
            elif role == "user":
                turns.append({"role": "user", "content": m.get("content") or ""})
            elif role == "assistant":
                if m.get("tool_calls"):
                    content: List[Dict[str, Any]] = []
                    if m.get("content"):
                        content.append({"type": "text", "text": m["content"]})
                    for tc in m["tool_calls"]:
                        content.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["arguments"]})
                    turns.append({"role": "assistant", "content": content})
                else:
                    turns.append({"role": "assistant", "content": m.get("content") or ""})
            elif role == "tool":
                turns.append({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"]}],
                })
        return "\n".join(p for p in system_parts if p), turns

    def _to_wire_tools(self, tools: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools]

    def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None) -> ChatResult:
        if not self.api_key:
            raise AIProviderError("Claude API key is not configured. See .env.example.", status_code=503)

        system_text, turns = self._split_system_and_turns(messages)
        payload: Dict[str, Any] = {"model": self.model, "max_tokens": 1024, "temperature": 0.2, "messages": turns}
        if system_text:
            payload["system"] = system_text
        if tools:
            payload["tools"] = self._to_wire_tools(tools)
            payload["tool_choice"] = {"type": "auto"}

        data = _http_post_json(
            url="https://api.anthropic.com/v1/messages",
            payload=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
            },
        )

        blocks = data.get("content") or []
        if not blocks:
            error = data.get("error") or {}
            detail = error.get("message") if error else None
            suffix = f": {detail}" if detail else ""
            raise AIProviderError(f"Claude response did not include any content{suffix}")

        text_chunks = [b["text"] for b in blocks if b.get("type") == "text"]
        tool_calls = [
            ToolCall(id=b.get("id", ""), name=b.get("name", ""), arguments=b.get("input") or {})
            for b in blocks if b.get("type") == "tool_use"
        ]
        return ChatResult(content="\n".join(text_chunks).strip(), tool_calls=tool_calls)


def get_ai_provider() -> ChatProvider:
    """Build the active provider from env vars. Raises AIProviderError only for a
    misconfigured/unknown AI_PROVIDER value - a missing API key is deferred to the
    first chat() call so the rest of the app can still start.
    """
    provider_name = (os.getenv("AI_PROVIDER") or "openai").strip().lower()

    if provider_name == "openai":
        api_key = os.getenv("OPENAI_API_KEY") or os.getenv("CHATGPT_API_KEY") or ""
        model = os.getenv("OPENAI_MODEL") or os.getenv("CHATGPT_MODEL") or "gpt-4o-mini"
        return OpenAICompatibleProvider(
            name="OpenAI", api_key=api_key, model=model,
            base_url="https://api.openai.com/v1/chat/completions",
        )

    if provider_name == "grok":
        api_key = os.getenv("GROK_API_KEY") or os.getenv("XAI_API_KEY") or ""
        model = os.getenv("GROK_MODEL") or "grok-4"
        return OpenAICompatibleProvider(
            name="Grok", api_key=api_key, model=model,
            base_url="https://api.x.ai/v1/chat/completions",
        )

    if provider_name == "gemini":
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY") or ""
        model = os.getenv("GEMINI_MODEL") or "gemini-2.5-flash"
        return GeminiProvider(api_key=api_key, model=model)

    if provider_name in ("claude", "anthropic"):
        api_key = os.getenv("ANTHROPIC_API_KEY") or ""
        model = os.getenv("ANTHROPIC_MODEL") or "claude-sonnet-5"
        return ClaudeProvider(api_key=api_key, model=model)

    raise AIProviderError(
        f"Unknown AI_PROVIDER '{provider_name}'. Supported: openai, grok, gemini, claude.",
        status_code=500,
    )
