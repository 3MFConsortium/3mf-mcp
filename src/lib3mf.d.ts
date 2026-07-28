declare module "@3mfconsortium/lib3mf" {
  interface Lib3mfModule {
    CWrapper: new () => any;
    FS: {
      writeFile(path: string, data: Uint8Array): void;
      unlink(path: string): void;
    };
    eModelUnit?: Record<string, unknown>;
    eBeamLatticeCapMode?: Record<string, unknown>;
    eBeamLatticeBallMode?: Record<string, unknown>;
  }

  export default function createLib3mf(): Promise<Lib3mfModule>;
}
