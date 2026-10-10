"""Real process/JSON comparison. No dependencies and no model calls."""
import json
from pathlib import Path
import subprocess
import sys

CASES = [
    (7, 3, "Ada", 2, 1, 3), (-7, 3, "太郎", -3, 2, 2),
    (7, -3, "", -3, -2, 0), (-7, -3, "🙂", 2, -1, 1),
    (0, 3, "e\u0301", 0, 0, 2), (6, 3, "a\nb", 2, 0, 3),
    (1, 2, "🧑‍💻", 0, 1, 3), (-1, 2, "a\"b", -1, 1, 3),
    (1, -2, "空 白", -1, -1, 3), (1000000, 3, "a", 333333, 1, 1),
    (1, 0, "Ada", None, None, None), (0, 0, "", None, None, None),
]


def run(command, data):
    result = subprocess.run(command, input=json.dumps(data), text=True,
                            capture_output=True, timeout=10, check=True)
    return json.loads(result.stdout)


def original(data):
    return run([sys.executable, "-B", "src/main.py"], data)


def expected(case):
    a, b, name, q, r, length = case
    return {"error": "division by zero"} if b == 0 else {
        "quotient": q, "remainder": r, "greeting": "Hello, " + name, "length": length}


def main():
    mode = sys.argv[1]
    if mode == "build":
        files = sorted(Path("ported").glob("*.mjs"))
        assert len(files) == 3, "expected exactly three target modules"
        for file in files:
            subprocess.run(["node", "--check", str(file)], check=True)
        print(json.dumps({"mode": mode, "checked": len(files)}))
        return
    assert mode in ("original", "mutation", "smoke", "parity"), mode
    mismatches = []
    cases = CASES[1:2] if mode == "smoke" else CASES
    for index, case in enumerate(cases):
        data = dict(zip(("a", "b", "name"), case[:3]))
        old = original(data)
        assert old == expected(case), ("original regression", data, old, expected(case))
        if mode == "original":
            continue
        new = run(["node", "tests/mutant.mjs" if mode == "mutation" else "ported/main.mjs"], data)
        if old != new:
            mismatches.append({"case": index, "input": data, "original": old, "target": new})
    if mode == "mutation":
        assert len(mismatches) >= 3, "judge did not detect the deliberately broken port"
    else:
        assert not mismatches, json.dumps(mismatches, ensure_ascii=False)
    print(json.dumps({"mode": mode, "cases": len(cases), "mismatches": len(mismatches),
                      "skipped": 0, "mutationDetected": mode == "mutation"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
