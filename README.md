# dia-viewer

DiagramManifest JSON 파일(ERD 또는 C4 아키텍처)을 인터랙티브하게 렌더링하는 정적 웹 뷰어입니다. 백엔드 없이 브라우저에서만 동작 — 매니페스트를 드래그·드롭으로 열고, 노드를 직접 배치하고, PNG/SVG/Layout JSON으로 내보냅니다.

`create-diagram` 같은 매니페스트 생성 스킬이 만든 결과물을 사람이 보고 다듬는 용도로 설계됐습니다.

## 사전 요구사항

- Node.js 18 이상

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

브라우저에서 http://localhost:5173 접속 후 매니페스트 JSON을 캔버스에 드래그·드롭하면 렌더링됩니다.

## 배포

정적 SPA라 어디든 올릴 수 있습니다.

```bash
npm run build
```

생성된 `dist/` 폴더를 Vercel · Netlify · GitHub Pages · S3 등에 그대로 호스팅. GitHub Pages 같은 서브패스 호스팅을 쓰면 `vite.config.ts`에 `base: '/dia-viewer/'` 한 줄 추가 필요합니다.
