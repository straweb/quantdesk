"use client"

import { Toaster as Sonner, ToasterProps } from "sonner"

// NOTE: intentionally NOT using next-themes' useTheme() here — there is no
// ThemeProvider mounted in the root layout (the app is forced dark via
// <html className="dark">), and useTheme() without a provider is a known
// source of React hydration mismatches. Theme is pinned to "dark".
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="top-left"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
