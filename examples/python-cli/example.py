#!/usr/bin/env python3
"""跨语言 CLI 最小消费示例（T18 步骤 5）。

通过参数数组启动已安装的 `img-to-template` CLI，读取单个 JSON 对象及退出码。
覆盖：成功（0）、参数错误（64）、执行失败（1）、严格待复查（2）。

运行（需先安装归档；不依赖 tsx / 仓库 src）：
    python example.py <已安装CLI的绝对路径> <模板包目录>
"""

import json
import subprocess
import sys


def run_cli(cli_path: str, args: list[str]) -> tuple[int, dict | None]:
    """启动 CLI 子进程；--json 时 stdout 恰好一个 JSON 对象。"""
    completed = subprocess.run(
        [cli_path, *args, "--json"],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    parsed = None
    stdout = completed.stdout.strip()
    if stdout:
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError:
            parsed = None
    return completed.returncode, parsed


def main() -> int:
    if len(sys.argv) < 3:
        print("用法：python example.py <CLI 绝对路径> <模板包目录>", file=sys.stderr)
        return 64

    cli_path, bundle_dir = sys.argv[1], sys.argv[2]

    # 1. 成功 / 待复查路径：render（--json 输出单对象）
    code, result = run_cli(cli_path, ["render", bundle_dir])
    if result is None:
        print("render 的 stdout 不是单个 JSON 对象", file=sys.stderr)
        return 1
    print(json.dumps({"case": "render", "exit": code, "status": result.get("status")},
                     ensure_ascii=False))

    # 2. 参数错误：缺位置参数 → 64；stdout 是 error 对象
    code, result = run_cli(cli_path, ["render"])
    print(json.dumps({"case": "missing-arg", "exit": code,
                      "error": (result or {}).get("error", {}).get("code")},
                     ensure_ascii=False))

    # 3. 执行失败：不存在的模板包 → 1
    code, result = run_cli(cli_path, ["render", "Z:/definitely/not/exist"])
    print(json.dumps({"case": "missing-bundle", "exit": code,
                      "error": (result or {}).get("error", {}).get("code")},
                     ensure_ascii=False))

    # 4. 严格待复查（如字体缺失复查项）→ 2
    code, result = run_cli(cli_path, ["render", bundle_dir, "--strict"])
    print(json.dumps({"case": "strict", "exit": code,
                      "status": (result or {}).get("status")},
                     ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
