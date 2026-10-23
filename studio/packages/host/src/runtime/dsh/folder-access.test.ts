import { describe, expect, it } from "vitest";
import { grantFailurePath, readIcacls } from "./folder-access.js";

// What `icacls <folder>` printed on the person's machine (2026-10-23), trimmed.
const MODIFY_ONLY = `G:\\PROJECT\\project_mining_dev S-1-5-21-1798683511-2594250425-3452088577-3985546160:(OI)(CI)(M)
                              KANGAROO-COM\\CodexSandboxUsers:(I)(OI)(CI)(M,DC)
                              BUILTIN\\Administrators:(I)(F)
                              BUILTIN\\Administrators:(I)(OI)(CI)(IO)(F)
                              NT AUTHORITY\\SYSTEM:(I)(F)
                              NT AUTHORITY\\Authenticated Users:(I)(M)
                              NT AUTHORITY\\Authenticated Users:(I)(OI)(CI)(IO)(M)
                              BUILTIN\\Users:(I)(RX)

Successfully processed 1 files; Failed processing 0 files`;

const ROOT_ONLY = `E:\\TOOLS\\AMO Everyone:(CI)(DENY)(DC)
             S-1-4-156389378-875321128:(OI)(CI)(W,D,DC)
             KANGAROO-COM\\Kangaroo:(F)
             NT AUTHORITY\\Authenticated Users:(I)(OI)(CI)(IO)(M)
             Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)
`;

describe("folder access for DSH's write sandbox", () => {
  it("finds the folder in DSH's error", () => {
    expect(grantFailurePath("Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(G:\\PROJECT\\project_mining_dev)")).toBe("G:\\PROJECT\\project_mining_dev");
    expect(grantFailurePath("Error: the user rejected escalating this command")).toBeNull();
    expect(grantFailurePath("SetNamedSecurityInfoW failed (Win32 1336): grantWrite(C:\\x)")).toBeNull();
  });

  it("Modify only, or full control of the folder alone, is not enough; inherited full control is", () => {
    expect(readIcacls(MODIFY_ONLY, "G:\\PROJECT\\project_mining_dev", "Kangaroo")).toEqual({ ok: false, labelled: false });
    expect(readIcacls(ROOT_ONLY, "E:\\TOOLS\\AMO", "Kangaroo")).toEqual({ ok: false, labelled: true });
    const fixed = ROOT_ONLY.replace("KANGAROO-COM\\Kangaroo:(F)", "KANGAROO-COM\\Kangaroo:(F)\n             KANGAROO-COM\\Kangaroo:(OI)(CI)(F)");
    expect(readIcacls(fixed, "E:\\TOOLS\\AMO", "kangaroo")).toEqual({ ok: true, labelled: true });
    // Inherited from the profile folder, as under C:\Users\<name>.
    expect(readIcacls("C:\\Users\\K\\proj KANGAROO-COM\\Kangaroo:(I)(OI)(CI)(F)\n", "C:\\Users\\K\\proj", "Kangaroo").ok).toBe(true);
  });

  it("counts only the person and the everyone-groups, and never a deny", () => {
    expect(readIcacls("D:\\w BUILTIN\\Administrators:(OI)(CI)(F)\n", "D:\\w", "Kangaroo").ok).toBe(false);
    expect(readIcacls("D:\\w Everyone:(OI)(CI)(F)\n", "D:\\w", "Kangaroo").ok).toBe(true);
    expect(readIcacls("D:\\w KANGAROO-COM\\Kangaroo:(OI)(CI)(DENY)(F)\n", "D:\\w", "Kangaroo").ok).toBe(false);
    expect(readIcacls("D:\\w KANGAROO-COM\\Kangaroo:(OI)(CI)(IO)(F)\n", "D:\\w", "Kangaroo").ok).toBe(false);
  });
});
