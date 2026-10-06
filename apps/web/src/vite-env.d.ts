/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUNTIME_MODE?: "web" | "desktop-local";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
