import { ownerName } from "@/lib/instance";
import type { MetadataRoute } from "next";

// Makes the OS installable as a phone app ("Add to Home Screen" on iPhone, "Install app" on Android).
// Served at /manifest.webmanifest, which the auth proxy lets through without a session (PUBLIC_PATHS).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "GenLimitless OS",
    short_name: "GenLimitless",
    description: `${ownerName()}'s internal AI operating system for GenLimitless`,
    start_url: "/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/app-icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
