import { Component, type ErrorInfo, type ReactNode } from "react";

import { logClientError } from "@/lib/client-logger";

type Props = {
  children: ReactNode;
  // Optional human label, used in the console log so we can tell which
  // boundary tripped when there are several mounted.
  label?: string;
  // Optional fallback. When omitted, the boundary swallows the error and
  // renders nothing — useful for non-critical background widgets where the
  // right behavior on crash is "disappear", not "blank the whole app".
  fallback?: ReactNode;
};

type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info);
    logClientError(error, `ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}`, {
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}
