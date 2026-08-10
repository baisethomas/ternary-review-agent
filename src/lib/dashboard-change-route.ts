type DashboardChangesHandlerDependencies = {
  isAuthenticated(): Promise<boolean>;
  readCursor(): Promise<number>;
};

export function createDashboardChangesHandler(dependencies: DashboardChangesHandlerDependencies) {
  return async function dashboardChangesHandler() {
    if (!await dependencies.isAuthenticated()) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return Response.json(
      { cursor: await dependencies.readCursor() },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  };
}
