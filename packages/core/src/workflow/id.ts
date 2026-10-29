import { z } from "zod";

/*
 * A user's workflow is `user-<uuid>` wherever a workflow id goes (settings,
 * the picker, the art and scene routes), so every wire schema stays a
 * string. Server workflow files may not use the prefix, so the two sets
 * never collide.
 */

export const USER_WORKFLOW_PREFIX = "user-";

/** A stored workflow's uuid: lowercase, so its id matches the workflow id pattern. */
export const workflowUuidSchema = z.uuid().lowercase();

/** The id a user workflow goes by; anything but a lowercase uuid throws. */
export function userWorkflowId(uuid: string): string {
  if (!workflowUuidSchema.safeParse(uuid).success) {
    throw new RangeError("a user workflow id needs a lowercase uuid");
  }
  return `${USER_WORKFLOW_PREFIX}${uuid}`;
}

/** The stored uuid a user workflow id names, or undefined for any other id. */
export function userWorkflowUuid(id: string): string | undefined {
  if (!id.startsWith(USER_WORKFLOW_PREFIX)) return undefined;
  const uuid = id.slice(USER_WORKFLOW_PREFIX.length);
  return workflowUuidSchema.safeParse(uuid).success ? uuid : undefined;
}

export const isUserWorkflowId = (id: string): boolean => userWorkflowUuid(id) !== undefined;
