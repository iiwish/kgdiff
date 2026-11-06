/**
 * The session of `<kgdiff-viewer>`: a `DiffSession` (state, commands, events; `session.ts`) with
 * the one view of the default layout's canvas (`StageView`, `view.ts`: renderer, camera,
 * framing, minimap) built in, so the layout and its tests address both as one object. A
 * `<kgdiff-stage>` bound to the viewer adds a view of its own; `fit()` and `zoom()` reach all.
 */
import type { Camera } from '@kgdiff/renderer';
import type { ChromeLayout } from './framing.js';
import { DiffSession, type SessionDeps, type SessionHost } from './session.js';
import { StageView } from './view.js';

export type { Preference, Status, Topic } from './session.js';
export type { FitOptions } from './view.js';
export {
  coverage,
  FIT_MAX_ZOOM,
  FLY_MAX_ZOOM,
  FOLLOW_COVERAGE,
  OVERVIEW_COVERAGE,
  USER_CAMERA_GRACE,
} from './view.js';
export type ControllerHost = SessionHost;
export type ControllerDeps = SessionDeps;

export class ViewerController extends DiffSession {
  /** The default layout's canvas. */
  readonly view: StageView;

  constructor(host: SessionHost, deps: SessionDeps) {
    super(host, deps);
    this.view = new StageView(this);
    this.addView(this.view);
  }

  /** Keep the canvas fitted (`StageView.autoFit`). */
  get autoFit(): boolean {
    return this.view.autoFit;
  }

  set autoFit(value: boolean) {
    this.view.autoFit = value;
  }

  /** Canvas clicks select (`StageView.selectOnClick`). */
  get selectOnClick(): boolean {
    return this.view.selectOnClick;
  }

  set selectOnClick(value: boolean) {
    this.view.selectOnClick = value;
  }

  /** The whole content is in the canvas's view (the minimap has nothing to add). */
  get overview(): boolean {
    return this.view.overview;
  }

  get camera(): Camera | null {
    return this.view.camera;
  }

  attach(stage: HTMLElement, minimapHost: HTMLElement | null): void {
    this.view.attach(stage, minimapHost);
  }

  detach(): void {
    this.view.detach();
    this.sleep();
  }

  override destroy(): void {
    super.destroy();
    this.view.detach();
  }

  setChrome(provider: (() => ChromeLayout) | null): void {
    this.view.setChrome(provider);
  }

  setLabelsInside(inside: boolean): void {
    this.view.setLabelsInside(inside);
  }

  layoutChanged(): void {
    this.view.layoutChanged();
  }

  noteUserCamera(): void {
    this.view.noteUserCamera();
  }
}
