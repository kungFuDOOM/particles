import { createFileRoute } from "@tanstack/react-router";
import { AetherApp } from "@/components/aether-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <AetherApp />;
}
