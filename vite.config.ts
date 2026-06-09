import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages는 https://<user>.github.io/<repo>/ 형태로 서브패스에서 서빙되므로
// 빌드 결과 안의 자산 URL을 그 prefix로 맞춰야 한다.
export default defineConfig({
  plugins: [react()],
  base: "/dia-viewer/",
  define: { __STANDALONE__: "false" },
  // strictPort: 다른 포트로 조용히 넘어가지 않고 5175가 점유돼 있으면 실패하게 —
  // dev URL을 예측 가능하게 고정.
  server: { port: 5175, strictPort: true },
});
