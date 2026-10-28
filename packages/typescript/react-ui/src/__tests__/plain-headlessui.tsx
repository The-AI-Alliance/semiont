/**
 * HeadlessUI's dialog parts as plain elements, for a suite about what a modal
 * says rather than how the dialog behaves:
 *
 *     vi.mock('@headlessui/react', () => import('<path>/__tests__/plain-headlessui'));
 *
 * The dialog is always open, and a transition shows its children while
 * `show` is set. The suites that test the dialog itself render the real one.
 */
import type { HTMLAttributes, ReactNode } from 'react';

type DialogProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  children?: ReactNode | ((bag: { open: boolean }) => ReactNode);
  onClose?: (open: boolean) => void;
};

export const Dialog = ({ children, onClose, ...props }: DialogProps) => (
  <div role="dialog" {...props}>
    {typeof children === 'function' ? children({ open: true }) : children}
  </div>
);

export const DialogPanel = ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>;

export const DialogTitle = ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => <h2 {...props}>{children}</h2>;

export const Transition = ({ show, children }: { show?: boolean; children?: ReactNode }) => (show ? <>{children}</> : null);

export const TransitionChild = ({ children }: { children?: ReactNode }) => <>{children}</>;
