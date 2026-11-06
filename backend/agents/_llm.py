"""
Shared LLM Helper for PydanticAI Specialist Agents.
Uses Groq as the primary LLM provider (`groq:llama-3.3-70b-versatile`) with bounded retries,
token usage tracking, and safe structured output extraction across PydanticAI versions.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Tuple, Type, TypeVar
from pydantic import BaseModel
from pydantic_ai import Agent

logger = logging.getLogger("consultai.agents.llm")

T = TypeVar("T", bound=BaseModel)

DEFAULT_GROQ_MODEL = os.getenv("GROQ_MODEL", "groq:llama-3.3-70b-versatile")


def has_groq_api_key() -> bool:
    key = os.getenv("GROQ_API_KEY", "").strip()
    return bool(key and len(key) > 10)


def create_specialist_agent(
    *,
    name: str,
    output_type: Type[T],
    system_prompt: str,
    retries: int = 2,
) -> Agent[None, T]:
    """
    Constructs a PydanticAI Agent configured with `output_type` (PydanticAI 2.x standard).
    """
    model_name = DEFAULT_GROQ_MODEL if has_groq_api_key() else "test"
    return Agent(
        model_name,
        name=name,
        output_type=output_type,
        system_prompt=system_prompt,
        retries=retries,
        defer_model_check=True,
    )


async def run_pydantic_agent(
    agent: Agent[None, T],
    prompt: str,
) -> Tuple[T, int, int, int]:
    """
    Executes a PydanticAI agent and returns (output_model, prompt_tokens, completion_tokens, total_tokens).
    """
    model_override = DEFAULT_GROQ_MODEL if has_groq_api_key() else None
    if not model_override:
        raise RuntimeError("GROQ_API_KEY is not configured in environment.")

    result = await agent.run(prompt, model=model_override)
    output: T = getattr(result, "output", getattr(result, "data", None))

    prompt_tokens = 0
    completion_tokens = 0
    total_tokens = 0
    try:
        usage = result.usage()
        prompt_tokens = int(getattr(usage, "request_tokens", 0) or 0)
        completion_tokens = int(getattr(usage, "response_tokens", 0) or 0)
        total_tokens = int(getattr(usage, "total_tokens", prompt_tokens + completion_tokens) or 0)
    except Exception:
        pass

    return output, prompt_tokens, completion_tokens, total_tokens
