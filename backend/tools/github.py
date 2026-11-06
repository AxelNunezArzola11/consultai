"""
GitHub REST API Client for Deterministic Repository, Pull Request, and Candidate Signal Inspection.
Never fabricates verification results: explicitly distinguishes live GitHub API evidence
from unverified claims.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional
import httpx

from backend.schemas.responses import CandidateGitHubEvidence

logger = logging.getLogger("consultai.tools.github")


def _github_headers() -> Dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ConsultAI-MultiAgent-Platform",
    }
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def fetch_github_user_repos(github_username: str, max_repos: int = 8) -> List[CandidateGitHubEvidence]:
    """
    Fetches real public repositories for a GitHub username via the GitHub REST API.
    If the user does not exist or API is rate-limited, returns an empty list rather than fabricating data.
    """
    clean_handle = (github_username or "").strip().lstrip("@")
    if not clean_handle:
        return []

    url = f"https://api.github.com/users/{clean_handle}/repos"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                url,
                params={"sort": "updated", "per_page": max_repos, "type": "owner"},
                headers=_github_headers(),
            )
            if resp.status_code != 200:
                logger.info("GitHub API returned %s for user %s", resp.status_code, clean_handle)
                return []

            items = resp.json()
            if not isinstance(items, list):
                return []

            evidence: List[CandidateGitHubEvidence] = []
            for repo in items[:max_repos]:
                if not isinstance(repo, dict):
                    continue
                evidence.append(
                    CandidateGitHubEvidence(
                        repo_name=str(repo.get("full_name") or repo.get("name") or clean_handle),
                        repo_url=str(repo.get("html_url") or f"https://github.com/{clean_handle}"),
                        primary_language=repo.get("language"),
                        stars=int(repo.get("stargazers_count") or 0),
                        description=repo.get("description"),
                        verified_via_api=True,
                    )
                )
            return evidence
    except Exception as exc:
        logger.warning("Failed to fetch GitHub repos for %s: %s", clean_handle, exc)
        return []


async def fetch_pull_request_evidence(
    repo_full_name: str,
    pr_number: int,
    diff_url: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Fetches verified Pull Request metadata, changed files, and diff snippet from GitHub REST API.
    """
    result: Dict[str, Any] = {
        "verified_via_api": False,
        "changed_files": [],
        "diff_text": "",
        "head_sha": None,
        "mergeable_state": None,
    }
    if not repo_full_name or not pr_number:
        return result

    headers = _github_headers()
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            pr_resp = await client.get(
                f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}",
                headers=headers,
            )
            if pr_resp.status_code == 200:
                pr_data = pr_resp.json()
                result["verified_via_api"] = True
                result["head_sha"] = pr_data.get("head", {}).get("sha")
                result["mergeable_state"] = pr_data.get("mergeable_state")

            files_resp = await client.get(
                f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}/files",
                headers=headers,
            )
            if files_resp.status_code == 200 and isinstance(files_resp.json(), list):
                result["changed_files"] = [
                    str(f.get("filename")) for f in files_resp.json() if isinstance(f, dict) and f.get("filename")
                ]

            target_diff_url = diff_url or f"https://api.github.com/repos/{repo_full_name}/pulls/{pr_number}"
            diff_headers = dict(headers)
            diff_headers["Accept"] = "application/vnd.github.v3.diff"
            diff_resp = await client.get(target_diff_url, headers=diff_headers)
            if diff_resp.status_code == 200:
                result["diff_text"] = diff_resp.text[:15000]
    except Exception as exc:
        logger.warning("Error fetching PR evidence for %s#%s: %s", repo_full_name, pr_number, exc)

    return result
