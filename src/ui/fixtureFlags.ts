/** Dev-only: `&signin=1` forces the signed-out screen so it can be captured without an Access session. */
export const forcedSignIn = (loc: Pick<Location, "search">): boolean => import.meta.env.DEV && new URLSearchParams(loc.search).get("signin") === "1";
