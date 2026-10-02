import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class Uri {
  public readonly scheme = "file";
  public readonly authority = "";
  public readonly query = "";
  public readonly fragment = "";
  public readonly fsPath: string;
  public readonly path: string;

  private constructor(filePath: string) {
    this.fsPath = path.resolve(filePath);
    this.path = this.fsPath.split(path.sep).join("/");
  }

  public static file(filePath: string): Uri {
    return new Uri(filePath);
  }

  public static parse(value: string): Uri {
    return new Uri(fileURLToPath(new URL(value)));
  }

  public static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(path.resolve(base.fsPath, ...parts));
  }

  public with(options: {
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(options.path ?? this.fsPath);
  }

  public toString(): string {
    return pathToFileURL(this.fsPath).href;
  }
}

export const workspace = {
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      return new Uint8Array(await readFile(uri.fsPath));
    },
  },
};

export const extensions = {
  getExtension(): undefined {
    return undefined;
  },
};
