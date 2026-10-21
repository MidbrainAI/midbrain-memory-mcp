/**
 * History readers by client id (issue #75). Each reader lists its sessions
 * and reads one of them; see ../plan.mjs for the session shape. Each client
 * registers its reader here.
 */

export const READERS = {};
