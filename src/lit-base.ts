import { LitElement } from "lit";

/** Base for migrated components. Renders into light DOM (not a shadow root) so
 *  the global Tailwind stylesheet still applies and Playwright class-selectors
 *  in the e2e suite keep resolving. */
export class LightElement extends LitElement {
  protected createRenderRoot() {
    return this;
  }
}
