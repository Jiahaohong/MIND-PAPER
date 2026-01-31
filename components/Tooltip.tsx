import React, { useEffect, useRef, useState } from 'react';

type TooltipProps = {
  label: string;
  delay?: number;
  placement?: 'top' | 'bottom';
  wrapperClassName?: string;
  children: React.ReactElement;
};

export const Tooltip: React.FC<TooltipProps> = ({
  label,
  delay = 1000,
  placement = 'bottom',
  wrapperClassName = '',
  children
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    clearTimer();
    setVisible(false);
  };

  useEffect(() => () => clearTimer(), []);

  const childProps = children.props as Record<string, any>;
  const mergedProps = {
    ...childProps,
    'aria-label': label,
    onMouseEnter: (event: React.MouseEvent) => {
      childProps.onMouseEnter?.(event);
      show();
    },
    onMouseLeave: (event: React.MouseEvent) => {
      childProps.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: React.FocusEvent) => {
      childProps.onFocus?.(event);
      show();
    },
    onBlur: (event: React.FocusEvent) => {
      childProps.onBlur?.(event);
      hide();
    }
  };

  const tooltipPosition =
    placement === 'top'
      ? 'bottom-full mb-1'
      : 'top-full mt-1';

  return (
    <span className={`relative inline-flex ${wrapperClassName}`}>
      {React.cloneElement(children, mergedProps)}
      {visible ? (
        <span
          className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${tooltipPosition} z-50 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-[10px] text-white shadow`}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
};
