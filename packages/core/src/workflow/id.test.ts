import { describe, expect, it } from "vitest";
import { comfyuiWorkflowIdSchema } from "../settings.ts";
import { USER_WORKFLOW_PREFIX, userWorkflowId, userWorkflowUuid } from "./id.ts";

const UUID = "0b6f7c3e-2d4a-4f8e-9a1b-5c6d7e8f9a0b";

describe("user workflow ids", () => {
  it("prefixes the uuid and passes the workflow id schema", () => {
    const id = userWorkflowId(UUID);
    expect(id).toBe(`${USER_WORKFLOW_PREFIX}${UUID}`);
    expect(id).toHaveLength(41);
    expect(comfyuiWorkflowIdSchema.safeParse(id).success).toBe(true);
  });

  it("reads the uuid back and recognises only user ids", () => {
    expect(userWorkflowUuid(userWorkflowId(UUID))).toBe(UUID);
    for (const id of ["krea2-gonzalomo", "user-", "user-flux", `user-${UUID}-x`, UUID]) {
      expect(userWorkflowUuid(id)).toBeUndefined();
    }
  });

  it("refuses what is not a lowercase uuid", () => {
    expect(() => userWorkflowId("flux")).toThrow(RangeError);
    expect(() => userWorkflowId(UUID.toUpperCase())).toThrow(RangeError);
    expect(userWorkflowUuid(`user-${UUID.toUpperCase()}`)).toBeUndefined();
  });
});
