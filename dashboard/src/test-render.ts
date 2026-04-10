import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

export function renderComponent<Props>(
  Component: ComponentType<Props>,
  props: Props,
): string {
  return renderToStaticMarkup(createElement(Component as any, props as any));
}
