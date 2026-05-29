import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages는 https://<user>.github.io/<repo>/ 형태로 서브패스에서 서빙되므로
// 빌드 결과 안의 자산 URL을 그 prefix로 맞춰야 한다.
export default defineConfig({
  plugins: [react()],
  base: "/dia-viewer/",
});
