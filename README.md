# dia-viewer

DiagramManifest JSON 파일(ERD 또는 C4 아키텍처)을 인터랙티브하게 렌더링하는 정적 웹 뷰어입니다. 백엔드 없이 브라우저에서만 동작 — 매니페스트를 드래그·드롭으로 열면 자동 배치·라우팅되고, 노드를 직접 옮겨 다듬은 뒤 PNG/SVG/Layout JSON으로 내보냅니다.

`create-diagram` 같은 매니페스트 생성 스킬이 만든 결과물을 사람이 보고 다듬는 용도로 설계됐습니다.

## 사전 요구사항

- Node.js 20 (CI 기준 — 18 이상에서 동작)

## 빠른 시작

### 1. 클론 & 설치

```bash
git clone git@github.com:sminchang/dia-viewer.git
cd dia-viewer
npm install
```

### 2. 실행

```bash
npm run dev
```

브라우저에서 http://localhost:5173/dia-viewer/ 접속 후 매니페스트 JSON을 캔버스에 드래그·드롭하면 렌더링됩니다.

## 배포

`main` 브랜치에 푸시하면 GitHub Actions(`.github/workflows/deploy.yml`)가 GitHub Pages로 자동 배포합니다.

다른 곳에 올리려면:

```bash
npm run build
```

생성된 `dist/`를 Vercel · Netlify · S3 등에 정적 호스팅하면 됩니다. 단, 빌드 자산 경로가 GitHub Pages 서브패스(`/dia-viewer/`) 기준이므로 루트 도메인에 올릴 땐 `vite.config.ts`의 `base`를 조정하세요.
