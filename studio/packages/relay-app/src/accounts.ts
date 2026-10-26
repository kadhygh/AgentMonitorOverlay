import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SavedAccount } from "@amo-studio/relay";

// The accounts this desktop client remembers (<home>/accounts.json), newest first. A password is kept only encrypted
// by the OS (Electron safeStorage: DPAPI on Windows, Keychain on a Mac); where that is unavailable it is not kept.

export interface Crypto {
  available(): boolean;
  encrypt(text: string): string;
  decrypt(data: string): string;
}

interface Stored {
  server: string;
  name: string;
  password: string | null;
  lastUsed: number;
}

export class Accounts {
  private readonly file: string;

  constructor(
    home: string,
    private readonly crypto: Crypto,
  ) {
    this.file = join(home, "accounts.json");
  }

  private read(): Stored[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Stored[];
    } catch {
      return [];
    }
  }

  private write(list: Stored[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(list, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  list(): SavedAccount[] {
    return this.read().map((a) => {
      let password: string | null = null;
      if (a.password) {
        try {
          password = this.crypto.decrypt(a.password);
        } catch {
          password = null; // another user or machine: ask again
        }
      }
      return { server: a.server, name: a.name, password, lastUsed: a.lastUsed };
    });
  }

  save(a: { server: string; name: string; password: string | null }): void {
    const password = a.password && this.crypto.available() ? this.crypto.encrypt(a.password) : null;
    const rest = this.read().filter((x) => !(x.server === a.server && x.name === a.name));
    this.write([{ server: a.server, name: a.name, password, lastUsed: Date.now() }, ...rest].slice(0, 20));
  }

  forget(server: string, name: string): void {
    this.write(this.read().filter((x) => !(x.server === server && x.name === name)));
  }
}
