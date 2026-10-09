// PostToolUse(Write|Edit) 훅: Claude가 수정한 파일을 포맷한다.
// 포맷터가 아직 설치되지 않았으면 조용히 넘어간다.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const file = input.tool_response?.filePath ?? input.tool_input?.file_path;
if (!file || !existsSync(file)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const ext = extname(file).toLowerCase();
const prettierExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".json", ".html"]);

if (ext === ".rs") {
  spawnSync("rustfmt", ["--edition", "2021", file], { stdio: "ignore" });
} else if (prettierExts.has(ext)) {
  const prettier = join(root, "node_modules", "prettier", "bin", "prettier.cjs");
  if (existsSync(prettier)) {
    spawnSync(process.execPath, [prettier, "--write", "--log-level", "silent", file], { stdio: "ignore" });
  }
}

process.exit(0);
