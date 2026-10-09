/** Why the current task is being declined. Solvers call why() as they bail out; handleItem resets it
 *  per task and the item log line carries it, so a skip in a scored run is never a mystery. */
let current = "";
export const why = (reason: string) => { current = reason; };
export const resetWhy = () => { current = ""; };
export const takeWhy = () => current || "unspecified";
export const hasWhy = () => current !== "";
