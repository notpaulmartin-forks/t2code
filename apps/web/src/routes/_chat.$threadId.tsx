import { ThreadId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import ThreadTerminalView from "../components/ThreadTerminalView";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { SidebarInset } from "../components/ui/sidebar";

function ChatThreadRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const navigate = useNavigate();
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadExists = useComposerDraftStore((store) =>
    Object.hasOwn(store.draftThreadsByThreadId, threadId),
  );
  const routeThreadExists = threadExists || draftThreadExists;

  useEffect(() => {
    if (!bootstrapComplete) {
      return;
    }
    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, navigate, routeThreadExists]);

  if (!bootstrapComplete || !routeThreadExists) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <ThreadTerminalView threadId={threadId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$threadId")({
  component: ChatThreadRouteView,
});
