"""Score native action ordering; keep retrieved text in private artifacts only."""

import json
import pathlib
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 scripts/score-memory-priming.py ARTIFACT_DIR")
root = pathlib.Path(sys.argv[1])
rows = []
for p in sorted(root.glob("*.json")):
    try:
        d = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        continue
    if not isinstance(d, dict) or "stdout" not in d:
        continue
    client = d["id"].split("-")[0]
    events = []
    for line in d["stdout"].splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    actions = []
    answers = []
    tokens = []
    for e in events:
        if client == "codex":
            i = e.get("item", {})
            if e.get("type") == "item.started":
                if i.get("type") == "mcp_tool_call":
                    actions.append(
                        {"name": i.get("tool"), "args": i.get("arguments", {})}
                    )
                elif i.get("type") == "command_execution":
                    actions.append(
                        {"name": "shell", "args": {"command": i.get("command")}}
                    )
                elif i.get("type") in ["web_search", "tool_call"]:
                    actions.append({"name": i.get("type"), "args": i})
            if e.get("type") == "item.completed" and i.get("type") == "agent_message":
                answers.append(i.get("text", ""))
            if e.get("type") == "turn.completed":
                tokens.append(e.get("usage", {}))
        elif client == "hermes":
            if e.get("type") == "tool_use":
                actions.append({"name": e.get("name"), "args": e.get("input", {})})
            if e.get("type") == "result":
                answers.append(e.get("text", ""))
                tokens.append(e.get("tokens", {}))
        elif client == "opencode":
            i = e.get("part", {})
            if e.get("type") == "tool_use":
                actions.append(
                    {"name": i.get("tool"), "args": i.get("state", {}).get("input", {})}
                )
            if e.get("type") == "text":
                answers.append(i.get("text", ""))
            if e.get("type") == "step_finish":
                tokens.append(i.get("tokens", {}))
    audit = root / (p.stem + ".audit.jsonl")
    ae = (
        [json.loads(x) for x in audit.read_text().splitlines()]
        if audit.exists()
        else []
    )
    calls = [x for x in ae if x["kind"] == "tool"]
    substantive = [
        a
        for a in actions
        if a["name"]
        not in ["tool_search", "tool_describe", "search_tool", "tools_search"]
    ]
    first = substantive[0] if substantive else {}
    search = next((a for a in calls if a["name"] == "memory_search"), {})
    anchor = d["task"]["anchor"]
    request_id = anchor[len("issue ") :] if anchor.startswith("issue ") else anchor
    row = {k: d[k] for k in ["id", "identity", "code", "seconds"]}
    row.update(
        client=client,
        firstAction=first.get("name"),
        memoryFirst="memory_search" in (first.get("name") or ""),
        initialAnchorPreserved=anchor in search.get("args", {}).get("query", ""),
        initialRequestIdPreserved=request_id in search.get("args", {}).get("query", ""),
        startsNear10=8 <= search.get("args", {}).get("limit", 0) <= 12,
        widened50=any(
            a["name"] == "memory_search" and a["args"].get("limit") == 50 for a in calls
        ),
        toolCount=len(calls),
        identityReads=[e for e in ae if e["kind"] == "identity"],
        httpErrors=[
            e
            for e in ae
            if e["kind"] == "http" and ("error" in e or e.get("status", 0) >= 400)
        ],
        tokens=tokens,
        answer=answers[-1] if answers else "",
        actions=actions,
    )
    rows.append(row)
# Raw answers remain in the private artifact directory, never in the public summary.
scored = root / "scored-results.json"
scored.write_text(json.dumps(rows, indent=2))
scored.chmod(0o600)
public = [{k: v for k, v in r.items() if k not in ["answer", "actions"]} for r in rows]
(root / "summary.json").write_text(json.dumps(public, indent=2))
for r in rows:
    print(
        r["id"],
        r["code"],
        round(r["seconds"], 1),
        "prime=" + str(r["memoryFirst"]),
        "anchor=" + str(r["initialAnchorPreserved"]),
        "10=" + str(r["startsNear10"]),
        "50=" + str(r["widened50"]),
        "errors=" + str(len(r["httpErrors"])),
    )
print("Completed", len(rows))
