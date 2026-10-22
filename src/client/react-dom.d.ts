// The page provides react-dom at run time (scripts/build-client.mjs); this is
// the one function the client uses, so no @types/react-dom is needed.
declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react'
  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactPortal
}
