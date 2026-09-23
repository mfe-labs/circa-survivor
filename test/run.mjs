import { execSync } from "node:child_process";
for (const t of ["lines", "model", "ratings", "circa", "dili", "http", "openleg", "entries", "holiday"]) {
  execSync(`npx esbuild test/${t}.test.jsx --bundle --platform=node --outfile=test/${t}.test.cjs --loader:.jsx=jsx --jsx=automatic --external:react --external:react-dom`, { stdio: "inherit" });
  console.log(`\n== ${t} ==`); execSync(`node test/${t}.test.cjs`, { stdio: "inherit" });
}
