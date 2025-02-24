/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ɵPLATFORM_BROWSER_ID as PLATFORM_BROWSER_ID} from '@angular/common';
import {Component, Input, NgZone, PLATFORM_ID, QueryList, Type, ViewChildren, ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR} from '@angular/core';
import {getComponentDef} from '@angular/core/src/render3/definition';
import {DeferBlockBehavior, fakeAsync, flush, TestBed} from '@angular/core/testing';

/**
 * Clears all associated directive defs from a given component class.
 *
 * This is a *hack* for TestBed, which compiles components in JIT mode
 * and can not remove dependencies and their imports in the same way as AOT.
 * From JIT perspective, all dependencies inside a defer block remain eager.
 * We need to clear this association to run tests that verify loading and
 * prefetching behavior.
 */
function clearDirectiveDefs(type: Type<unknown>): void {
  const cmpDef = getComponentDef(type);
  cmpDef!.dependencies = [];
  cmpDef!.directiveDefs = null;
}

/**
 * Emulates a dynamic import promise.
 *
 * Note: `setTimeout` is used to make `fixture.whenStable()` function
 * wait for promise resolution, since `whenStable()` relies on the state
 * of a macrotask queue.
 */
function dynamicImportOf<T>(type: T, timeout = 0): Promise<T> {
  return new Promise<T>(resolve => {
    setTimeout(() => resolve(type), timeout);
  });
}

/**
 * Emulates a failed dynamic import promise.
 */
function failedDynamicImport(): Promise<void> {
  return new Promise((_, reject) => {
    setTimeout(() => reject());
  });
}

/**
 * Helper function to await all pending dynamic imports
 * emulated using `dynamicImportOf` function.
 */
function allPendingDynamicImports() {
  return dynamicImportOf(null, 10);
}

// Set `PLATFORM_ID` to a browser platform value to trigger defer loading
// while running tests in Node.
const COMMON_PROVIDERS = [{provide: PLATFORM_ID, useValue: PLATFORM_BROWSER_ID}];

describe('@defer', () => {
  beforeEach(() => {
    TestBed.configureTestingModule(
        {providers: COMMON_PROVIDERS, deferBlockBehavior: DeferBlockBehavior.Playthrough});
  });

  it('should transition between placeholder, loading and loaded states', async () => {
    @Component({
      selector: 'my-lazy-cmp',
      standalone: true,
      template: 'Hi!',
    })
    class MyLazyCmp {
    }

    @Component({
      standalone: true,
      selector: 'simple-app',
      imports: [MyLazyCmp],
      template: `
        @defer (when isVisible) {
          <my-lazy-cmp />
        } @loading {
          Loading...
        } @placeholder {
          Placeholder!
        } @error {
          Failed to load dependencies :(
        }
      `
    })
    class MyCmp {
      isVisible = false;
    }

    const fixture = TestBed.createComponent(MyCmp);
    fixture.detectChanges();

    expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

    fixture.componentInstance.isVisible = true;
    fixture.detectChanges();

    expect(fixture.nativeElement.outerHTML).toContain('Loading');

    // Wait for dependencies to load.
    await allPendingDynamicImports();
    fixture.detectChanges();

    expect(fixture.nativeElement.outerHTML).toContain('<my-lazy-cmp>Hi!</my-lazy-cmp>');
  });

  it('should work when only main block is present', async () => {
    @Component({
      selector: 'my-lazy-cmp',
      standalone: true,
      template: 'Hi!',
    })
    class MyLazyCmp {
    }

    @Component({
      standalone: true,
      selector: 'simple-app',
      imports: [MyLazyCmp],
      template: `
        <p>Text outside of a defer block</p>
        @defer (when isVisible) {
          <my-lazy-cmp />
        }
      `
    })
    class MyCmp {
      isVisible = false;
    }

    const fixture = TestBed.createComponent(MyCmp);
    fixture.detectChanges();

    expect(fixture.nativeElement.outerHTML).toContain('Text outside of a defer block');

    fixture.componentInstance.isVisible = true;
    fixture.detectChanges();

    // Wait for dependencies to load.
    await allPendingDynamicImports();
    fixture.detectChanges();

    expect(fixture.nativeElement.outerHTML).toContain('<my-lazy-cmp>Hi!</my-lazy-cmp>');
  });

  describe('`on` conditions', () => {
    it('should support `on immediate` condition', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @defer (on immediate) {
            <nested-cmp [block]="'primary'" />
          } @placeholder {
            Placeholder
          } @loading {
            Loading
          }
        `
      })
      class RootCmp {
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          ...COMMON_PROVIDERS,
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      // Expecting that no placeholder content would be rendered when
      // a loading block is present.
      expect(fixture.nativeElement.outerHTML).toContain('Loading');

      // Expecting loading function to be triggered right away.
      expect(loadingFnInvokedTimes).toBe(1);

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was not invoked again.
      expect(loadingFnInvokedTimes).toBe(1);

      // Verify primary block content.
      const primaryBlockHTML = fixture.nativeElement.outerHTML;
      expect(primaryBlockHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });
  });


  describe('directive matching', () => {
    it('should support directive matching in all blocks', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'simple-app',
        imports: [NestedCmp],
        template: `
        @defer (when isVisible) {
          <nested-cmp [block]="'primary'" />
        } @loading {
          Loading...
          <nested-cmp [block]="'loading'" />
        } @placeholder {
          Placeholder!
          <nested-cmp [block]="'placeholder'" />
        } @error {
          Failed to load dependencies :(
          <nested-cmp [block]="'error'" />
        }
      `
      })
      class MyCmp {
        isVisible = false;
      }

      const fixture = TestBed.createComponent(MyCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="placeholder">Rendering placeholder block.</nested-cmp>');

      fixture.componentInstance.isVisible = true;
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="loading">Rendering loading block.</nested-cmp>');

      // Wait for dependencies to load.
      await allPendingDynamicImports();
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');
    });
  });

  describe('error handling', () => {
    it('should render an error block when loading fails', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'simple-app',
        imports: [NestedCmp],
        template: `
          @defer (when isVisible) {
            <nested-cmp [block]="'primary'" />
          } @loading {
            Loading...
          } @placeholder {
            Placeholder!
          } @error {
            Failed to load dependencies :(
            <nested-cmp [block]="'error'" />
          }
          `
      })
      class MyCmp {
        isVisible = false;
        @ViewChildren(NestedCmp) cmps!: QueryList<NestedCmp>;
      }

      const deferDepsInterceptor = {
        intercept() {
          return () => [failedDynamicImport()];
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      const fixture = TestBed.createComponent(MyCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      fixture.componentInstance.isVisible = true;
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Loading');

      // Wait for dependencies to load.
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify that the error block is rendered.
      // Also verify that selector matching works in an error block.
      expect(fixture.nativeElement.outerHTML)
          .toContain('<nested-cmp ng-reflect-block="error">Rendering error block.</nested-cmp>');

      // Verify that queries work within an error block.
      expect(fixture.componentInstance.cmps.length).toBe(1);
      expect(fixture.componentInstance.cmps.get(0)?.block).toBe('error');
    });
  });

  describe('queries', () => {
    it('should query for components within each block', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'simple-app',
        imports: [NestedCmp],
        template: `
          @defer (when isVisible) {
            <nested-cmp [block]="'primary'" />
          } @loading {
            Loading...
            <nested-cmp [block]="'loading'" />
          } @placeholder {
            Placeholder!
            <nested-cmp [block]="'placeholder'" />
          } @error {
            Failed to load dependencies :(
            <nested-cmp [block]="'error'" />
          }
        `
      })
      class MyCmp {
        isVisible = false;

        @ViewChildren(NestedCmp) cmps!: QueryList<NestedCmp>;
      }

      const fixture = TestBed.createComponent(MyCmp);
      fixture.detectChanges();

      expect(fixture.componentInstance.cmps.length).toBe(1);
      expect(fixture.componentInstance.cmps.get(0)?.block).toBe('placeholder');
      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="placeholder">Rendering placeholder block.</nested-cmp>');

      fixture.componentInstance.isVisible = true;
      fixture.detectChanges();

      expect(fixture.componentInstance.cmps.length).toBe(1);
      expect(fixture.componentInstance.cmps.get(0)?.block).toBe('loading');
      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="loading">Rendering loading block.</nested-cmp>');

      // Wait for dependencies to load.
      await allPendingDynamicImports();
      fixture.detectChanges();

      expect(fixture.componentInstance.cmps.length).toBe(1);
      expect(fixture.componentInstance.cmps.get(0)?.block).toBe('primary');
      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');
    });
  });

  describe('content projection', () => {
    it('should be able to project content into each block', async () => {
      @Component({
        selector: 'cmp-a',
        standalone: true,
        template: 'CmpA',
      })
      class CmpA {
      }

      @Component({
        selector: 'cmp-b',
        standalone: true,
        template: 'CmpB',
      })
      class CmpB {
      }

      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'my-app',
        imports: [NestedCmp],
        template: `
          @defer (when isVisible) {
            <nested-cmp [block]="'primary'" />
            <ng-content />
          } @loading {
            Loading...
            <nested-cmp [block]="'loading'" />
          } @placeholder {
            Placeholder!
            <nested-cmp [block]="'placeholder'" />
          } @error {
            Failed to load dependencies :(
            <nested-cmp [block]="'error'" />
          }
        `
      })
      class MyCmp {
        @Input() isVisible = false;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [MyCmp, CmpA, CmpB],
        template: `
          <my-app [isVisible]="isVisible">
            Projected content.
            <b>Including tags</b>
            <cmp-a />
            @defer (when isInViewport) {
              <cmp-b />
            } @placeholder {
              Projected defer block placeholder.
            }
          </my-app>
        `
      })
      class RootCmp {
        isVisible = false;
        isInViewport = false;
      }

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="placeholder">Rendering placeholder block.</nested-cmp>');

      fixture.componentInstance.isVisible = true;
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="loading">Rendering loading block.</nested-cmp>');

      // Wait for dependencies to load.
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify primary block content.
      const primaryBlockHTML = fixture.nativeElement.outerHTML;
      expect(primaryBlockHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');
      expect(primaryBlockHTML).toContain('Projected content.');
      expect(primaryBlockHTML).toContain('<b>Including tags</b>');
      expect(primaryBlockHTML).toContain('<cmp-a>CmpA</cmp-a>');
      expect(primaryBlockHTML).toContain('Projected defer block placeholder.');

      fixture.componentInstance.isInViewport = true;
      fixture.detectChanges();

      // Wait for projected block dependencies to load.
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Nested defer block was triggered and the `CmpB` content got rendered.
      expect(fixture.nativeElement.outerHTML).toContain('<cmp-b>CmpB</cmp-b>');
    });
  });

  describe('nested blocks', () => {
    it('should be able to have nested blocks', async () => {
      @Component({
        selector: 'cmp-a',
        standalone: true,
        template: 'CmpA',
      })
      class CmpA {
      }

      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp, CmpA],
        template: `
          @defer (when isVisible) {
            <nested-cmp [block]="'primary'" />

            @defer (when isInViewport) {
              <cmp-a />
            } @placeholder {
              Nested defer block placeholder.
            }
          } @placeholder {
            <nested-cmp [block]="'placeholder'" />
          }
        `
      })
      class RootCmp {
        isVisible = false;
        isInViewport = false;
      }

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="placeholder">Rendering placeholder block.</nested-cmp>');

      fixture.componentInstance.isVisible = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify primary block content.
      const primaryBlockHTML = fixture.nativeElement.outerHTML;
      expect(primaryBlockHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');

      // Make sure we have a nested block in a placeholder state.
      expect(primaryBlockHTML).toContain('Nested defer block placeholder.');

      // Trigger condition for the nested block.
      fixture.componentInstance.isInViewport = true;
      fixture.detectChanges();

      // Wait for nested block dependencies to load.
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Nested defer block was triggered and the `CmpB` content got rendered.
      expect(fixture.nativeElement.outerHTML).toContain('<cmp-a>CmpA</cmp-a>');
    });
  });

  describe('prefetch', () => {
    /**
     * Sets up interceptors for when an idle callback is requested
     * and when it's cancelled. This is needed to keep track of calls
     * made to `requestIdleCallback` and `cancelIdleCallback` APIs.
     */
    let idleCallbacksRequested = 0;
    const onIdleCallbackQueue: IdleRequestCallback[] = [];

    let nativeRequestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) =>
        number;
    let nativeCancelIdleCallback: (id: number) => void;

    const mockRequestIdleCallback =
        (callback: IdleRequestCallback, options?: IdleRequestOptions): number => {
          onIdleCallbackQueue.push(callback);
          expect(idleCallbacksRequested).toBe(0);
          expect(NgZone.isInAngularZone()).toBe(true);
          idleCallbacksRequested++;
          return 0;
        };

    const mockCancelIdleCallback = (id: number) => {
      expect(idleCallbacksRequested).toBe(1);
      idleCallbacksRequested--;
    };

    const triggerIdleCallbacks = () => {
      for (const callback of onIdleCallbackQueue) {
        callback(null!);
      }
      onIdleCallbackQueue.length = 0;  // empty the queue
    };

    beforeEach(() => {
      nativeRequestIdleCallback = globalThis.requestIdleCallback;
      nativeCancelIdleCallback = globalThis.cancelIdleCallback;
      globalThis.requestIdleCallback = mockRequestIdleCallback;
      globalThis.cancelIdleCallback = mockCancelIdleCallback;
    });

    afterEach(() => {
      globalThis.requestIdleCallback = nativeRequestIdleCallback;
      globalThis.cancelIdleCallback = nativeCancelIdleCallback;
      onIdleCallbackQueue.length = 0;  // clear the queue
    });

    it('should be able to prefetch resources', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @defer (when deferCond; prefetch when prefetchCond) {
            <nested-cmp [block]="'primary'" />
          } @placeholder {
            Placeholder
          }
        `
      })
      class RootCmp {
        deferCond = false;
        prefetchCond = false;
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      // Trigger prefetching.
      fixture.componentInstance.prefetchCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Expect that placeholder content is still rendered.
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Trigger main content.
      fixture.componentInstance.deferCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify primary block content.
      const primaryBlockHTML = fixture.nativeElement.outerHTML;
      expect(primaryBlockHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });

    it('should handle a case when prefetching fails', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @defer (when deferCond; prefetch when prefetchCond) {
            <nested-cmp [block]="'primary'" />
          } @error {
            Loading failed
          } @placeholder {
            Placeholder
          }
        `
      })
      class RootCmp {
        deferCond = false;
        prefetchCond = false;
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [failedDynamicImport()];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      // Trigger prefetching.
      fixture.componentInstance.prefetchCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Expect that placeholder content is still rendered.
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Trigger main content.
      fixture.componentInstance.deferCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Since prefetching failed, expect the error block to be rendered.
      expect(fixture.nativeElement.outerHTML).toContain('Loading failed');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });

    it('should work when loading and prefetching were kicked off at the same time', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @defer (when deferCond; prefetch when deferCond) {
            <nested-cmp [block]="'primary'" />
          } @error {
            Loading failed
          } @placeholder {
            Placeholder
          }
        `
      })
      class RootCmp {
        deferCond = false;
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      // Trigger prefetching and loading at the same time.
      fixture.componentInstance.deferCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once,
      // even though both main loading and prefetching were kicked off
      // at the same time.
      expect(loadingFnInvokedTimes).toBe(1);

      // Expect the main content to be rendered.
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary block');
    });

    it('should support `prefetch on idle` condition', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @defer (when deferCond; prefetch on idle) {
            <nested-cmp [block]="'primary'" />
          } @placeholder {
            Placeholder
          }
        `
      })
      class RootCmp {
        deferCond = false;
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Expect that placeholder content is still rendered.
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Trigger main content.
      fixture.componentInstance.deferCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify primary block content.
      const primaryBlockHTML = fixture.nativeElement.outerHTML;
      expect(primaryBlockHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });

    it('should trigger prefetching based on `on idle` only once', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @for (item of items; track item) {
            @defer (when deferCond; prefetch on idle) {
              <nested-cmp [block]="'primary for \`' + item + '\`'" />
            } @placeholder {
              Placeholder \`{{ item }}\`
            }
          }
        `
      })
      class RootCmp {
        deferCond = false;
        items = ['a', 'b', 'c'];
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `a`');
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `b`');
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `c`');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Expect that placeholder content is still rendered.
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `a`');

      // Trigger main content.
      fixture.componentInstance.deferCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify primary blocks content.
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `a` block');
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `b` block');
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `c` block');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });

    it('should trigger fetching based on `on idle` only once', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @for (item of items; track item) {
            @defer (on idle; prefetch on idle) {
              <nested-cmp [block]="'primary for \`' + item + '\`'" />
            } @placeholder {
              Placeholder \`{{ item }}\`
            }
          }
        `
      })
      class RootCmp {
        items = ['a', 'b', 'c'];
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `a`');
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `b`');
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `c`');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Verify primary blocks content.
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `a` block');
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `b` block');
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `c` block');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });

    it('should support `prefetch on immediate` condition', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @defer (when deferCond; prefetch on immediate) {
            <nested-cmp [block]="'primary'" />
          } @placeholder {
            Placeholder
          }
        `
      })
      class RootCmp {
        deferCond = false;
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          ...COMMON_PROVIDERS,
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Expecting loading function to be triggered right away.
      expect(loadingFnInvokedTimes).toBe(1);

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Expect that placeholder content is still rendered.
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder');

      // Trigger main content.
      fixture.componentInstance.deferCond = true;
      fixture.detectChanges();

      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify primary block content.
      const primaryBlockHTML = fixture.nativeElement.outerHTML;
      expect(primaryBlockHTML)
          .toContain(
              '<nested-cmp ng-reflect-block="primary">Rendering primary block.</nested-cmp>');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });

    it('should delay nested defer blocks with `on idle` triggers', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Primary block content.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        selector: 'another-nested-cmp',
        standalone: true,
        template: 'Nested block component.',
      })
      class AnotherNestedCmp {
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp, AnotherNestedCmp],
        template: `
          @defer (on idle; prefetch on idle) {
            <nested-cmp [block]="'primary for \`' + item + '\`'" />

            <!--
              Expecting that nested defer block would be initialized
              in a subsequent "requestIdleCallback" call.
            -->
            @defer (on idle) {
              <another-nested-cmp />
            } @placeholder {
              Nested block placeholder
            } @loading {
              Nested block loading
            }

          } @placeholder {
            Root block placeholder
          }
        `
      })
      class RootCmp {
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            const nextDeferredComponent =
                loadingFnInvokedTimes === 1 ? NestedCmp : AnotherNestedCmp;
            return [dynamicImportOf(nextDeferredComponent)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Root block placeholder');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      // Trigger all scheduled callbacks and await all mocked dynamic imports.
      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Verify primary blocks content.
      expect(fixture.nativeElement.outerHTML).toContain('Primary block content');

      // Verify that nested defer block is in a placeholder mode.
      expect(fixture.nativeElement.outerHTML).toContain('Nested block placeholder');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);

      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify that nested defer block now renders the main content.
      expect(fixture.nativeElement.outerHTML).toContain('Nested block component');

      // We loaded a nested block dependency, expect counter to be 2.
      expect(loadingFnInvokedTimes).toBe(2);
    });

    it('should not request idle callback for each block in a for loop', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Rendering {{ block }} block.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp],
        template: `
          @for (item of items; track item) {
            @defer (on idle; prefetch on idle) {
              <nested-cmp [block]="'primary for \`' + item + '\`'" />
            } @placeholder {
              Placeholder \`{{ item }}\`
            }
          }
        `
      })
      class RootCmp {
        items = ['a', 'b', 'c'];
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            return [dynamicImportOf(NestedCmp)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `a`');
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `b`');
      expect(fixture.nativeElement.outerHTML).toContain('Placeholder `c`');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      // Trigger all scheduled callbacks and await all mocked dynamic imports.
      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Verify primary blocks content.
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `a` block');
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `b` block');
      expect(fixture.nativeElement.outerHTML).toContain('Rendering primary for `c` block');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);
    });

    it('should delay nested defer blocks with `on idle` triggers', async () => {
      @Component({
        selector: 'nested-cmp',
        standalone: true,
        template: 'Primary block content.',
      })
      class NestedCmp {
        @Input() block!: string;
      }

      @Component({
        selector: 'another-nested-cmp',
        standalone: true,
        template: 'Nested block component.',
      })
      class AnotherNestedCmp {
      }

      @Component({
        standalone: true,
        selector: 'root-app',
        imports: [NestedCmp, AnotherNestedCmp],
        template: `
          @defer (on idle; prefetch on idle) {
            <nested-cmp [block]="'primary for \`' + item + '\`'" />
            <!--
              Expecting that nested defer block would be initialized
              in a subsequent "requestIdleCallback" call.
            -->
            @defer (on idle) {
              <another-nested-cmp />
            } @placeholder {
              Nested block placeholder
            } @loading {
              Nested block loading
            }

          } @placeholder {
            Root block placeholder
          }
        `
      })
      class RootCmp {
      }

      let loadingFnInvokedTimes = 0;
      const deferDepsInterceptor = {
        intercept() {
          return () => {
            loadingFnInvokedTimes++;
            const nextDeferredComponent =
                loadingFnInvokedTimes === 1 ? NestedCmp : AnotherNestedCmp;
            return [dynamicImportOf(nextDeferredComponent)];
          };
        }
      };

      TestBed.configureTestingModule({
        providers: [
          {provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR, useValue: deferDepsInterceptor},
        ],
        deferBlockBehavior: DeferBlockBehavior.Playthrough,
      });

      clearDirectiveDefs(RootCmp);

      const fixture = TestBed.createComponent(RootCmp);
      fixture.detectChanges();

      expect(fixture.nativeElement.outerHTML).toContain('Root block placeholder');

      // Make sure loading function is not yet invoked.
      expect(loadingFnInvokedTimes).toBe(0);

      // Trigger all scheduled callbacks and await all mocked dynamic imports.
      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Expect that the loading resources function was invoked once.
      expect(loadingFnInvokedTimes).toBe(1);

      // Verify primary blocks content.
      expect(fixture.nativeElement.outerHTML).toContain('Primary block content');

      // Verify that nested defer block is in a placeholder mode.
      expect(fixture.nativeElement.outerHTML).toContain('Nested block placeholder');

      // Expect that the loading resources function was not invoked again (counter remains 1).
      expect(loadingFnInvokedTimes).toBe(1);

      triggerIdleCallbacks();
      await allPendingDynamicImports();
      fixture.detectChanges();

      // Verify that nested defer block now renders the main content.
      expect(fixture.nativeElement.outerHTML).toContain('Nested block component');

      // We loaded a nested block dependency, expect counter to be 2.
      expect(loadingFnInvokedTimes).toBe(2);
    });
  });

  // Note: these cases specifically use `on interaction`, however
  // the resolution logic is the same for all triggers.
  describe('trigger resolution', () => {
    it('should resolve a trigger is outside the defer block', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
            @defer (on interaction(trigger)) {
              Main content
            } @placeholder {
              Placeholder
            }

            <div>
              <div>
                <div>
                  <button #trigger></button>
                </div>
            </div>
          </div>
          `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should resolve a trigger on a component outside the defer block', fakeAsync(() => {
         @Component({selector: 'some-comp', template: '<button></button>', standalone: true})
         class SomeComp {
         }

         @Component({
           standalone: true,
           imports: [SomeComp],
           template: `
            @defer (on interaction(trigger)) {
              Main content
            } @placeholder {
              Placeholder
            }

            <div>
              <div>
                <div>
                  <some-comp #trigger/>
                </div>
              </div>
            </div>
          `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should resolve a trigger that is on a parent element', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
            <button #trigger>
              <div>
                <div>
                @defer (on interaction(trigger)) {
                  Main content
                } @placeholder {
                  Placeholder
                }
                </div>
              </div>
            </button>
          `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should resolve a trigger that is inside a parent embedded view', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
            @if (cond) {
              <button #trigger></button>

              @if (cond) {
                @if (cond) {
                  @defer (on interaction(trigger)) {
                    Main content
                  } @placeholder {
                    Placeholder
                  }
                }
              }
            }
          `
         })
         class MyCmp {
           cond = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should resolve a trigger that is on a component in a parent embedded view',
       fakeAsync(() => {
         @Component({selector: 'some-comp', template: '<button></button>', standalone: true})
         class SomeComp {
         }

         @Component({
           standalone: true,
           imports: [SomeComp],
           template: `
              @if (cond) {
                <some-comp #trigger/>

                @if (cond) {
                  @if (cond) {
                    @defer (on interaction(trigger)) {
                      Main content
                    } @placeholder {
                      Placeholder
                    }
                  }
                }
              }
            `
         })
         class MyCmp {
           cond = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should resolve a trigger that is inside the placeholder', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
              @defer (on interaction(trigger)) {
                Main content
              } @placeholder {
                Placeholder <div><div><div><button #trigger></button></div></div></div>
              }
            `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should resolve a trigger that is a component inside the placeholder', fakeAsync(() => {
         @Component({selector: 'some-comp', template: '<button></button>', standalone: true})
         class SomeComp {
         }

         @Component({
           standalone: true,
           imports: [SomeComp],
           template: `
              @defer (on interaction(trigger)) {
                Main content
              } @placeholder {
                Placeholder <div><div><div><some-comp #trigger/></div></div></div>
              }
            `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));
  });

  describe('interaction triggers', () => {
    it('should load the deferred content when the trigger is clicked', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
              @defer (on interaction(trigger)) {
                Main content
              } @placeholder {
                Placeholder
              }

              <button #trigger></button>
            `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should load the deferred content when the trigger receives a keyboard event',
       fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           template: `
              @defer (on interaction(trigger)) {
                Main content
              } @placeholder {
                Placeholder
              }

              <button #trigger></button>
            `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         button.dispatchEvent(new Event('keydown'));
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should load the deferred content when an implicit trigger is clicked', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
             @defer (on interaction) {
               Main content
             } @placeholder {
               <button>Placeholder</button>
             }
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should load the deferred content if a child of the trigger is clicked', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
              @defer (on interaction(trigger)) {
                Main content
              } @placeholder {
                Placeholder
              }

             <div #trigger>
               <div>
                <button></button>
               </div>
             </div>
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should support multiple deferred blocks with the same trigger', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
             @defer (on interaction(trigger)) {
              Main content 1
             } @placeholder {
              Placeholder 1
             }

             @defer (on interaction(trigger)) {
              Main content 2
             } @placeholder {
              Placeholder 2
             }

             <button #trigger></button>
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder 1  Placeholder 2');

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content 1  Main content 2');
       }));

    it('should unbind the trigger events when the deferred block is loaded', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
             @defer (on interaction(trigger)) {Main content}
             <button #trigger></button>
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button = fixture.nativeElement.querySelector('button');
         const spy = spyOn(button, 'removeEventListener');

         button.click();
         fixture.detectChanges();
         flush();

         expect(spy).toHaveBeenCalledTimes(2);
         expect(spy).toHaveBeenCalledWith('click', jasmine.any(Function), jasmine.any(Object));
         expect(spy).toHaveBeenCalledWith('keydown', jasmine.any(Function), jasmine.any(Object));
       }));

    it('should unbind the trigger events when the trigger is destroyed', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
            @if (renderBlock) {
              @defer (on interaction(trigger)) {Main content}
              <button #trigger></button>
            }
          `
         })
         class MyCmp {
           renderBlock = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button = fixture.nativeElement.querySelector('button');
         const spy = spyOn(button, 'removeEventListener');

         fixture.componentInstance.renderBlock = false;
         fixture.detectChanges();

         expect(spy).toHaveBeenCalledTimes(2);
         expect(spy).toHaveBeenCalledWith('click', jasmine.any(Function), jasmine.any(Object));
         expect(spy).toHaveBeenCalledWith('keydown', jasmine.any(Function), jasmine.any(Object));
       }));

    it('should unbind the trigger events when the deferred block is destroyed', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
              @if (renderBlock) {
                @defer (on interaction(trigger)) {Main content}
              }

              <button #trigger></button>
            `
         })
         class MyCmp {
           renderBlock = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button = fixture.nativeElement.querySelector('button');
         const spy = spyOn(button, 'removeEventListener');

         fixture.componentInstance.renderBlock = false;
         fixture.detectChanges();

         expect(spy).toHaveBeenCalledTimes(2);
         expect(spy).toHaveBeenCalledWith('click', jasmine.any(Function), jasmine.any(Object));
         expect(spy).toHaveBeenCalledWith('keydown', jasmine.any(Function), jasmine.any(Object));
       }));

    it('should bind the trigger events inside the NgZone', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
           @defer (on interaction(trigger)) {
             Main content
           }

           <button #trigger></button>
         `
         })
         class MyCmp {
         }

         const eventsInZone: Record<string, boolean> = {};
         const fixture = TestBed.createComponent(MyCmp);
         const button = fixture.nativeElement.querySelector('button');

         spyOn(button, 'addEventListener').and.callFake((name: string) => {
           eventsInZone[name] = NgZone.isInAngularZone();
         });
         fixture.detectChanges();

         expect(eventsInZone).toEqual({click: true, keydown: true});
       }));

    it('should prefetch resources on interaction', fakeAsync(() => {
         @Component({
           standalone: true,
           selector: 'root-app',
           template: `
              @defer (when isLoaded; prefetch on interaction(trigger)) {Main content}
              <button #trigger></button>
            `
         })
         class MyCmp {
           // We need a `when` trigger here so that `on idle` doesn't get added automatically.
           readonly isLoaded = false;
         }

         let loadingFnInvokedTimes = 0;

         TestBed.configureTestingModule({
           providers: [
             {
               provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR,
               useValue: {
                 intercept: () => () => {
                   loadingFnInvokedTimes++;
                   return [];
                 }
               }
             },
           ],
           deferBlockBehavior: DeferBlockBehavior.Playthrough,
         });

         clearDirectiveDefs(MyCmp);

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(loadingFnInvokedTimes).toBe(0);

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();

         expect(loadingFnInvokedTimes).toBe(1);
       }));


    it('should prefetch resources on interaction with an implicit trigger', fakeAsync(() => {
         @Component({
           standalone: true,
           selector: 'root-app',
           template: `
             @defer (when isLoaded; prefetch on interaction) {
              Main content
             } @placeholder {
              <button></button>
             }
           `
         })
         class MyCmp {
           // We need a `when` trigger here so that `on idle` doesn't get added automatically.
           readonly isLoaded = false;
         }

         let loadingFnInvokedTimes = 0;

         TestBed.configureTestingModule({
           providers: [
             {
               provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR,
               useValue: {
                 intercept: () => () => {
                   loadingFnInvokedTimes++;
                   return [];
                 }
               }
             },
           ],
           deferBlockBehavior: DeferBlockBehavior.Playthrough,
         });

         clearDirectiveDefs(MyCmp);

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(loadingFnInvokedTimes).toBe(0);

         fixture.nativeElement.querySelector('button').click();
         fixture.detectChanges();
         flush();

         expect(loadingFnInvokedTimes).toBe(1);
       }));
  });

  describe('hover triggers', () => {
    it('should load the deferred content when the trigger is hovered', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           template: `
              @defer (on hover(trigger)) {
                Main content
              } @placeholder {
                Placeholder
              }

              <button #trigger></button>
            `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         button.dispatchEvent(new Event('mouseenter'));
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should load the deferred content with an implicit trigger element', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           template: `
             @defer (on hover) {
               Main content
             } @placeholder {
              <button>Placeholder</button>
             }
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         button.dispatchEvent(new Event('mouseenter'));
         fixture.detectChanges();
         flush();
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should support multiple deferred blocks with the same hover trigger', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           template: `
              @defer (on hover(trigger)) {
                Main content 1
              } @placeholder {
                Placeholder 1
              }

              @defer (on hover(trigger)) {
                Main content 2
              } @placeholder {
                Placeholder 2
              }

              <button #trigger></button>
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder 1  Placeholder 2');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         button.dispatchEvent(new Event('mouseenter'));
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content 1  Main content 2');
       }));

    it('should unbind the trigger events when the deferred block is loaded', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           template: `
             @defer (on hover(trigger)) {
              Main content
             }
             <button #trigger></button>
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button = fixture.nativeElement.querySelector('button');
         const spy = spyOn(button, 'removeEventListener');

         button.dispatchEvent(new Event('mouseenter'));
         fixture.detectChanges();
         flush();

         expect(spy).toHaveBeenCalledTimes(1);
         expect(spy).toHaveBeenCalledWith('mouseenter', jasmine.any(Function), jasmine.any(Object));
       }));

    it('should unbind the trigger events when the trigger is destroyed', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           template: `
            @if (renderBlock) {
              @defer (on hover(trigger)) {
                Main content
              }
              <button #trigger></button>
            }
          `
         })
         class MyCmp {
           renderBlock = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         const spy = spyOn(button, 'removeEventListener');

         fixture.componentInstance.renderBlock = false;
         fixture.detectChanges();

         expect(spy).toHaveBeenCalledTimes(1);
         expect(spy).toHaveBeenCalledWith('mouseenter', jasmine.any(Function), jasmine.any(Object));
       }));

    it('should unbind the trigger events when the deferred block is destroyed', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           template: `
              @if (renderBlock) {
                @defer (on hover(trigger)) {
                  Main content
                }
              }

              <button #trigger></button>
            `
         })
         class MyCmp {
           renderBlock = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button = fixture.nativeElement.querySelector('button');
         const spy = spyOn(button, 'removeEventListener');

         fixture.componentInstance.renderBlock = false;
         fixture.detectChanges();

         expect(spy).toHaveBeenCalledTimes(1);
         expect(spy).toHaveBeenCalledWith('mouseenter', jasmine.any(Function), jasmine.any(Object));
       }));

    it('should bind the trigger events inside the NgZone', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
          @defer (on hover(trigger)) {
            Main content
          }

          <button #trigger></button>
        `
         })
         class MyCmp {
         }

         const eventsInZone: Record<string, boolean> = {};
         const fixture = TestBed.createComponent(MyCmp);
         const button = fixture.nativeElement.querySelector('button');

         spyOn(button, 'addEventListener').and.callFake((name: string) => {
           eventsInZone[name] = NgZone.isInAngularZone();
         });
         fixture.detectChanges();

         expect(eventsInZone).toEqual({mouseenter: true});
       }));

    it('should prefetch resources on hover', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           selector: 'root-app',
           template: `
              @defer (when isLoaded; prefetch on hover(trigger)) {
                Main content
              }
              <button #trigger></button>
            `
         })
         class MyCmp {
           // We need a `when` trigger here so that `on idle` doesn't get added automatically.
           readonly isLoaded = false;
         }

         let loadingFnInvokedTimes = 0;

         TestBed.configureTestingModule({
           providers: [
             {
               provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR,
               useValue: {
                 intercept: () => () => {
                   loadingFnInvokedTimes++;
                   return [];
                 }
               }
             },
           ],
           deferBlockBehavior: DeferBlockBehavior.Playthrough,
         });

         clearDirectiveDefs(MyCmp);

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(loadingFnInvokedTimes).toBe(0);

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         button.dispatchEvent(new Event('mouseenter'));
         fixture.detectChanges();
         flush();

         expect(loadingFnInvokedTimes).toBe(1);
       }));


    it('should prefetch resources when an implicit trigger is hovered', fakeAsync(() => {
         // Domino doesn't support creating custom events so we have to skip this test.
         if (!isBrowser) {
           return;
         }

         @Component({
           standalone: true,
           selector: 'root-app',
           template: `
             @defer (when isLoaded; prefetch on hover) {
               Main content
             } @placeholder {
               <button></button>
             }
           `
         })
         class MyCmp {
           // We need a `when` trigger here so that `on idle` doesn't get added automatically.
           readonly isLoaded = false;
         }

         let loadingFnInvokedTimes = 0;

         TestBed.configureTestingModule({
           providers: [
             {
               provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR,
               useValue: {
                 intercept: () => () => {
                   loadingFnInvokedTimes++;
                   return [];
                 }
               }
             },
           ],
           deferBlockBehavior: DeferBlockBehavior.Playthrough,
         });

         clearDirectiveDefs(MyCmp);

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(loadingFnInvokedTimes).toBe(0);

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         button.dispatchEvent(new Event('mouseenter'));
         fixture.detectChanges();
         flush();

         expect(loadingFnInvokedTimes).toBe(1);
       }));
  });

  describe('viewport triggers', () => {
    let activeObservers: MockIntersectionObserver[] = [];
    let nativeIntersectionObserver: typeof IntersectionObserver;

    beforeEach(() => {
      nativeIntersectionObserver = globalThis.IntersectionObserver;
      globalThis.IntersectionObserver = MockIntersectionObserver;
    });

    afterEach(() => {
      globalThis.IntersectionObserver = nativeIntersectionObserver;
      activeObservers = [];
    });

    /**
     * Mocked out implementation of the native IntersectionObserver API. We need to
     * mock it out for tests, because it's unsupported in Domino and we can't trigger
     * it reliably in the browser.
     */
    class MockIntersectionObserver implements IntersectionObserver {
      root = null;
      rootMargin = null!;
      thresholds = null!;

      observedElements = new Set<Element>();
      private elementsInView = new Set<Element>();

      constructor(private callback: IntersectionObserverCallback) {
        activeObservers.push(this);
      }

      static invokeCallbacksForElement(element: Element, isInView: boolean) {
        for (const observer of activeObservers) {
          const elements = observer.elementsInView;
          const wasInView = elements.has(element);

          if (isInView) {
            elements.add(element);
          } else {
            elements.delete(element);
          }

          observer.invokeCallback();

          if (wasInView) {
            elements.add(element);
          } else {
            elements.delete(element);
          }
        }
      }

      private invokeCallback() {
        for (const el of this.observedElements) {
          this.callback(
              [{
                target: el,
                isIntersecting: this.elementsInView.has(el),

                // Unsupported properties.
                boundingClientRect: null!,
                intersectionRatio: null!,
                intersectionRect: null!,
                rootBounds: null,
                time: null!,
              }],
              this);
        }
      }

      observe(element: Element) {
        this.observedElements.add(element);
        // Native observers fire their callback as soon as an
        // element is observed so we try to mimic it here.
        this.invokeCallback();
      }

      unobserve(element: Element) {
        this.observedElements.delete(element);
      }

      disconnect() {
        this.observedElements.clear();
        this.elementsInView.clear();
      }

      takeRecords(): IntersectionObserverEntry[] {
        throw new Error('Not supported');
      }
    }

    it('should load the deferred content when the trigger is in the viewport', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
              @defer (on viewport(trigger)) {
                Main content
              } @placeholder {
                Placeholder
              }

              <button #trigger></button>
            `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         MockIntersectionObserver.invokeCallbacksForElement(button, true);
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should load the deferred content when an implicit trigger is in the viewport',
       fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
             @defer (on viewport) {
               Main content
             } @placeholder {
              <button>Placeholder</button>
             }
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         MockIntersectionObserver.invokeCallbacksForElement(button, true);
         fixture.detectChanges();
         flush();
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should not load the content if the trigger is not in the view yet', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
             @defer (on viewport(trigger)) {
              Main content
             } @placeholder {
              Placeholder
             }

             <button #trigger></button>
           `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         MockIntersectionObserver.invokeCallbacksForElement(button, false);
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         MockIntersectionObserver.invokeCallbacksForElement(button, false);
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder');

         MockIntersectionObserver.invokeCallbacksForElement(button, true);
         fixture.detectChanges();
         flush();

         expect(fixture.nativeElement.textContent.trim()).toBe('Main content');
       }));

    it('should support multiple deferred blocks with the same trigger', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
            @defer (on viewport(trigger)) {
              Main content 1
            } @placeholder {
              Placeholder 1
            }

            @defer (on viewport(trigger)) {
              Main content 2
            } @placeholder {
              Placeholder 2
            }

            <button #trigger></button>
          `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(fixture.nativeElement.textContent.trim()).toBe('Placeholder 1  Placeholder 2');

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         MockIntersectionObserver.invokeCallbacksForElement(button, true);
         fixture.detectChanges();
         flush();
         expect(fixture.nativeElement.textContent.trim()).toBe('Main content 1  Main content 2');
       }));

    it('should stop observing the trigger when the deferred block is loaded', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
            @defer (on viewport(trigger)) {
              Main content
            }
            <button #trigger></button>
          `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         expect(activeObservers.length).toBe(1);
         expect(activeObservers[0].observedElements.size).toBe(1);
         expect(activeObservers[0].observedElements.has(button)).toBe(true);

         MockIntersectionObserver.invokeCallbacksForElement(button, true);
         fixture.detectChanges();
         flush();

         expect(activeObservers.length).toBe(1);
         expect(activeObservers[0].observedElements.size).toBe(0);
       }));

    it('should stop observing the trigger when the trigger is destroyed', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
           @if (renderBlock) {
             @defer (on viewport(trigger)) {
              Main content
             }
             <button #trigger></button>
           }
         `
         })
         class MyCmp {
           renderBlock = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         expect(activeObservers.length).toBe(1);
         expect(activeObservers[0].observedElements.size).toBe(1);
         expect(activeObservers[0].observedElements.has(button)).toBe(true);

         fixture.componentInstance.renderBlock = false;
         fixture.detectChanges();

         expect(activeObservers.length).toBe(1);
         expect(activeObservers[0].observedElements.size).toBe(0);
       }));

    it('should stop observing the trigger when the deferred block is destroyed', fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
             @if (renderBlock) {
              @defer (on viewport(trigger)) {
                Main content
              }
             }

             <button #trigger></button>
           `
         })
         class MyCmp {
           renderBlock = true;
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         expect(activeObservers.length).toBe(1);
         expect(activeObservers[0].observedElements.size).toBe(1);
         expect(activeObservers[0].observedElements.has(button)).toBe(true);

         fixture.componentInstance.renderBlock = false;
         fixture.detectChanges();

         expect(activeObservers.length).toBe(1);
         expect(activeObservers[0].observedElements.size).toBe(0);
       }));

    it('should disconnect the intersection observer once all deferred blocks have been loaded',
       fakeAsync(() => {
         @Component({
           standalone: true,
           template: `
            <button #triggerOne></button>
            @defer (on viewport(triggerOne)) {
              One
            }

            <button #triggerTwo></button>
            @defer (on viewport(triggerTwo)) {
              Two
            }
          `
         })
         class MyCmp {
         }

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();
         expect(activeObservers.length).toBe(1);

         const buttons = Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('button'));
         const observer = activeObservers[0];
         const disconnectSpy = spyOn(observer, 'disconnect').and.callThrough();

         expect(Array.from(observer.observedElements)).toEqual(buttons);

         MockIntersectionObserver.invokeCallbacksForElement(buttons[0], true);
         fixture.detectChanges();

         expect(disconnectSpy).not.toHaveBeenCalled();
         expect(Array.from(observer.observedElements)).toEqual([buttons[1]]);

         MockIntersectionObserver.invokeCallbacksForElement(buttons[1], true);
         fixture.detectChanges();

         expect(disconnectSpy).toHaveBeenCalled();
         expect(observer.observedElements.size).toBe(0);
       }));

    it('should prefetch resources when the trigger comes into the viewport', fakeAsync(() => {
         @Component({
           standalone: true,
           selector: 'root-app',
           template: `
             @defer (when isLoaded; prefetch on viewport(trigger)) {
              Main content
             }
             <button #trigger></button>
           `
         })
         class MyCmp {
           // We need a `when` trigger here so that `on idle` doesn't get added automatically.
           readonly isLoaded = false;
         }

         let loadingFnInvokedTimes = 0;

         TestBed.configureTestingModule({
           providers: [
             {
               provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR,
               useValue: {
                 intercept: () => () => {
                   loadingFnInvokedTimes++;
                   return [];
                 }
               }
             },
           ],
           deferBlockBehavior: DeferBlockBehavior.Playthrough,
         });

         clearDirectiveDefs(MyCmp);

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(loadingFnInvokedTimes).toBe(0);

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         MockIntersectionObserver.invokeCallbacksForElement(button, true);
         fixture.detectChanges();
         flush();

         expect(loadingFnInvokedTimes).toBe(1);
       }));

    it('should prefetch resources when an implicit trigger comes into the viewport',
       fakeAsync(() => {
         @Component({
           standalone: true,
           selector: 'root-app',
           template: `
             @defer (when isLoaded; prefetch on viewport) {
              Main content
             } @placeholder {
               <button></button>
             }
           `
         })
         class MyCmp {
           // We need a `when` trigger here so that `on idle` doesn't get added automatically.
           readonly isLoaded = false;
         }

         let loadingFnInvokedTimes = 0;

         TestBed.configureTestingModule({
           providers: [
             {
               provide: ɵDEFER_BLOCK_DEPENDENCY_INTERCEPTOR,
               useValue: {
                 intercept: () => () => {
                   loadingFnInvokedTimes++;
                   return [];
                 }
               }
             },
           ],
           deferBlockBehavior: DeferBlockBehavior.Playthrough,
         });

         clearDirectiveDefs(MyCmp);

         const fixture = TestBed.createComponent(MyCmp);
         fixture.detectChanges();

         expect(loadingFnInvokedTimes).toBe(0);

         const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
         MockIntersectionObserver.invokeCallbacksForElement(button, true);
         fixture.detectChanges();
         flush();

         expect(loadingFnInvokedTimes).toBe(1);
       }));
  });
});
