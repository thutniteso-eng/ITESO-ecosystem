import * as React from 'react';
import { cn } from './utils';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
}

export const Alert: React.FC<AlertProps> = ({
  className,
  variant = 'info',
  title,
  children,
  ...props
}) => {
  const styles = {
    info: 'bg-blue-50 border-blue-200 text-blue-800',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    error: 'bg-red-50 border-red-200 text-red-800',
  };

  return (
    <div
      role="alert"
      className={cn('p-4 border rounded-lg text-sm', styles[variant], className)}
      {...props}
    >
      {title && <h5 className="font-semibold mb-1">{title}</h5>}
      <div className="text-sm">{children}</div>
    </div>
  );
};
