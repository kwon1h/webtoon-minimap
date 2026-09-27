// ==UserScript==
// @name         Webtoon Minimap
// @namespace    https://github.com/kwon1h/webtoon-minimap
// @version      1.0.0
// @description  이미지 미니맵과 스페이스바 스크롤을 원하는 사이트에서 활성화합니다.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

// 사이트별로 명시적으로 켠 곳에서만 기능을 실행합니다.
(function () {
  'use strict';
  const key = `webtoon_minimap_enabled:${location.protocol}//${location.hostname}`;
  const enabled = Boolean(GM_getValue(key, false));
  if (window.top === window) {
    GM_registerMenuCommand(
      enabled ? 'Webtoon Minimap: 이 사이트에서 끄기' : 'Webtoon Minimap: 이 사이트에서 켜기',
      () => {
        GM_setValue(key, !enabled);
        location.reload();
      }
    );
  }
  if (!enabled) return;

(function () {
  'use strict';

  /** =========================================================
   * 설정값
   * ======================================================= */

  const DEFAULT_PX = 1200;
  const STEP_PX = 100;
  const MIN_PX = 10;
  const MAX_PX = 4000;

  const DEFAULT_DURATION = 350;
  const STEP_DURATION = 100;
  const MIN_DURATION = 0;
  const MAX_DURATION = 3000;

  const EASING = 'easeOutCubic';

  // Minimap
  const MINIMAP_WIDTH = 148;
  const MINIMAP_GAP = 12;
  const MINIMAP_TOP = 14;
  const MINIMAP_BOTTOM = 14;

  const MIN_VIEWPORT_H = 28;
  const MIN_IMAGE_H = 1.5;

  // 긴 웹툰에서 스크롤 중 DOM/레이아웃 재구성이 겹치지 않도록 함.
  const REBUILD_SCROLL_IDLE_MS = 320;

  // expanded minimap은 현재 보이는 구간 주변만 DOM에 유지한다.
  const EXPANDED_RENDER_BUFFER_TRACKS = 1.5;

  // HUD
  const HUD_WIDTH = 220;
  const HUD_GAP = 10;

  // 작은 아이콘/광고 이미지 등을 어느 정도 제외
  const MIN_SOURCE_WIDTH = 180;
  const MIN_SOURCE_HEIGHT = 120;

  const STORAGE_PX = 'css_space_px_v1';
  const STORAGE_DUR = 'css_space_dur_v1';


  /** =========================================================
   * 기본 유틸
   * ======================================================= */

  const clamp = (v, lo, hi) =>
    Math.max(lo, Math.min(hi, v));


  const scrollingEl = () =>
    document.scrollingElement ||
    document.documentElement;


  const isTypingContext = (el) => {
    if (!el) return false;

    if (
      el.closest?.(
        'input, textarea, select'
      )
    ) {
      return true;
    }

    if (el.isContentEditable) {
      return true;
    }

    return false;
  };


  const isScrollable = (el) => {
    if (
      !el ||
      el === document.documentElement
    ) {
      return false;
    }

    const st =
      getComputedStyle(el);

    const canY =
      /(auto|scroll)/.test(
        st.overflowY
      );

    return (
      canY &&
      el.scrollHeight >
        el.clientHeight + 1
    );
  };


  const findScrollTarget = (start) => {
    let el = start;

    while (
      el &&
      el !== document.documentElement
    ) {
      if (isScrollable(el)) {
        return el;
      }

      el = el.parentElement;
    }

    return scrollingEl();
  };


  const getPrimaryScrollTarget = () => {
    const center =
      document.elementFromPoint(
        innerWidth / 2,
        innerHeight / 2
      );

    return findScrollTarget(
      center || document.body
    );
  };


  function getScrollMetrics(target) {
    const docEl = scrollingEl();

    const isDoc =
      target === docEl ||
      target === document.documentElement ||
      target === document.body;

    if (isDoc) {
      return {
        el: docEl,
        isDoc: true,

        scrollTop:
          window.scrollY ??
          docEl.scrollTop,

        scrollHeight:
          Math.max(
            docEl.scrollHeight,
            document.body?.scrollHeight || 0
          ),

        clientHeight:
          window.innerHeight
      };
    }

    return {
      el: target,
      isDoc: false,

      scrollTop:
        target.scrollTop,

      scrollHeight:
        target.scrollHeight,

      clientHeight:
        target.clientHeight
    };
  }


  const getPx = () => {
    const v =
      parseInt(
        localStorage.getItem(
          STORAGE_PX
        ),
        10
      );

    return Number.isFinite(v)
      ? clamp(
          v,
          MIN_PX,
          MAX_PX
        )
      : DEFAULT_PX;
  };


  const setPx = (v) => {
    const nv =
      clamp(
        v,
        MIN_PX,
        MAX_PX
      );

    localStorage.setItem(
      STORAGE_PX,
      String(nv)
    );

    updateHud();
    flashHudRow('distance');
  };


  const getDuration = () => {
    const v =
      parseInt(
        localStorage.getItem(
          STORAGE_DUR
        ),
        10
      );

    return Number.isFinite(v)
      ? clamp(
          v,
          MIN_DURATION,
          MAX_DURATION
        )
      : DEFAULT_DURATION;
  };


  const setDuration = (v) => {
    const nv =
      clamp(
        v,
        MIN_DURATION,
        MAX_DURATION
      );

    localStorage.setItem(
      STORAGE_DUR,
      String(nv)
    );

    updateHud();
    flashHudRow('duration');
  };


  /** =========================================================
   * easing
   * ======================================================= */

  const easings = {

    linear: (t) => t,

    easeOutCubic: (t) =>
      1 - Math.pow(1 - t, 3),

    easeInOutQuad: (t) =>
      t < 0.5
        ? 2 * t * t
        : 1 -
          Math.pow(-2 * t + 2, 2) /
            2
  };


  /** =========================================================
   * 실시간 minimap 업데이트
   * ======================================================= */

  let updateRaf = null;


  function requestMinimapUpdate() {

    if (updateRaf !== null) {
      return;
    }

    updateRaf =
      requestAnimationFrame(() => {

        updateRaf = null;

        updateMinimapViewport();

      });
  }


  /**
   * requestAnimationFrame를 기다리지 않고
   * 바로 갱신해야 할 때 사용.
   *
   * smooth animation 중에 호출.
   */
  function forceMinimapUpdate() {

    if (updateRaf !== null) {

      cancelAnimationFrame(
        updateRaf
      );

      updateRaf = null;
    }

    updateMinimapViewport();
  }


  /** =========================================================
   * Smooth Scroll
   * ======================================================= */

  const activeAnimations =
    new WeakMap();


  function animateScroll(
    target,
    delta,
    duration,
    easingName
  ) {

    const metrics =
      getScrollMetrics(target);

    const el =
      metrics.el;


    /** 즉시 이동 */

    if (duration <= 0) {

      const maxTop =
        Math.max(
          0,
          metrics.scrollHeight -
            metrics.clientHeight
        );

      const newTop =
        clamp(
          metrics.scrollTop +
            delta,
          0,
          maxTop
        );

      if (metrics.isDoc) {

        window.scrollTo(
          0,
          newTop
        );

      } else {

        el.scrollTop =
          newTop;
      }

      forceMinimapUpdate();

      return;
    }


    const ease =
      easings[easingName] ||
      easings.linear;


    const prev =
      activeAnimations.get(el);


    if (prev) {

      try {
        prev();
      } catch {}
    }


    let rafId = null;
    let startTime = null;

    const startTop =
      metrics.scrollTop;

    const maxTop =
      Math.max(
        0,
        metrics.scrollHeight -
          metrics.clientHeight
      );

    const endTop =
      clamp(
        startTop +
          delta,
        0,
        maxTop
      );

    let cancelled =
      false;


    const step = (now) => {

      if (cancelled) {
        return;
      }


      if (startTime === null) {
        startTime = now;
      }


      const t =
        clamp(
          (now - startTime) /
            duration,
          0,
          1
        );


      const p =
        ease(t);


      const newTop =
        startTop +
        (endTop - startTop) *
          p;


      if (metrics.isDoc) {

        window.scrollTo(
          0,
          newTop
        );

      } else {

        el.scrollTop =
          newTop;
      }


      /**
       * ★ 핵심 수정
       *
       * smooth scroll의 매 frame마다
       * minimap viewport도 동시에 갱신.
       */

      forceMinimapUpdate();


      if (t < 1) {

        rafId =
          requestAnimationFrame(
            step
          );

      } else {

        activeAnimations.delete(
          el
        );

        forceMinimapUpdate();
      }
    };


    const cancel = () => {

      cancelled = true;

      if (rafId !== null) {

        cancelAnimationFrame(
          rafId
        );
      }

      activeAnimations.delete(
        el
      );
    };


    activeAnimations.set(
      el,
      cancel
    );


    rafId =
      requestAnimationFrame(
        step
      );
  }


  const doScroll = (amount) => {

    animateScroll(
      getPrimaryScrollTarget(),
      amount,
      getDuration(),
      EASING
    );
  };


  /** =========================================================
   * Top frame 확인
   * ======================================================= */

  const isTop = (() => {

    try {

      return (
        window.top === window
      );

    } catch {

      return true;
    }

  })();


  /** =========================================================
   * UI 변수
   * ======================================================= */

  let minimapRoot;
  let minimapTrack;
  let minimapPreview;
  let minimapViewport;
  let minimapPercent;
  let hud;

  let hudRows = {};

  let primaryTarget = null;

  let observedScrollEl = null;

  let elementScrollListener = null;
  let windowScrollListener = null;

  let rebuildTimer = null;
  let lastScrollActivityAt = 0;

  let mutationObserver = null;
  let resizeObserver = null;

  let draggingViewport = false;
  let dragOffsetY = 0;

  // 드래그 중에는 geometry와 maxScroll을 고정한다.
  // 맨 아래에서 lazy-load/viewport 재계산이 서로 피드백되어
  // 핸들이 위아래로 튀는 현상을 방지한다.
  let dragSession = null;

  // 긴 웹툰에서 이미지 종횡비를 유지한 채
  // 세로로 이어 붙이는 가상 미니맵용 상태.
  let expandedPreviewMode = false;
  let expandedPreviewItems = [];
  let expandedPreviewHeight = 0;
  let expandedPreviewOffsetY = 0;
  let expandedMetricsSnapshot = null;

  // 긴 preview 전체를 거대한 DOM으로 만들지 않고,
  // 현재 보이는 구간 주변만 가상 렌더링한다.
  let expandedRenderStart = -1;
  let expandedRenderEnd = -1;
  let expandedRenderBaseY = 0;
  let expandedRenderLayer = null;


  /**
   * iframe에서는 UI를 만들지 않음.
   */
  if (!isTop) {

    installKeyboardHandlers();

    return;
  }


  /** =========================================================
   * CSS
   * ======================================================= */

  function injectStyles() {

    const style =
      document.createElement(
        'style'
      );

    style.id =
      'css-visual-minimap-style';


    style.textContent = `

      #css-minimap-root {

        position: fixed;

        top:
          ${MINIMAP_TOP}px;

        right:
          ${MINIMAP_GAP}px;

        bottom:
          ${MINIMAP_BOTTOM}px;

        width:
          ${Math.max(
            MINIMAP_WIDTH,
            HUD_WIDTH
          )}px;

        z-index:
          2147483646;

        display: flex;

        flex-direction:
          column;

        align-items:
          flex-end;

        gap:
          ${HUD_GAP}px;

        font-family:
          Inter,
          ui-sans-serif,
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;

        color: #fff;

        pointer-events:
          none;
      }


      #css-minimap-track {

        width:
          ${MINIMAP_WIDTH}px;

        flex:
          1 1 auto;

        min-height:
          220px;

        position:
          relative;

        overflow:
          hidden;

        border-radius:
          12px;

        background:
          rgba(
            10,
            12,
            16,
            .46
          );

        border:
          1px solid
          rgba(
            255,
            255,
            255,
            .14
          );

        box-shadow:
          0 10px 34px
          rgba(
            0,
            0,
            0,
            .30
          ),

          inset
          0 0 0 1px
          rgba(
            0,
            0,
            0,
            .16
          );

        backdrop-filter:
          blur(10px)
          saturate(120%);

        -webkit-backdrop-filter:
          blur(10px)
          saturate(120%);

        pointer-events:
          auto;

        cursor:
          pointer;

        user-select:
          none;

        touch-action:
          none;
      }


      #css-minimap-preview {

        position:
          absolute;

        inset: 0;

        overflow:
          hidden;

        pointer-events:
          none;

        background:
          linear-gradient(
            180deg,
            rgba(
              255,
              255,
              255,
              .025
            ),
            rgba(
              255,
              255,
              255,
              .01
            )
          );
      }


      #css-minimap-preview
      .css-mini-img {

        position:
          absolute;

        left:
          4px;

        right:
          4px;

        width:
          calc(
            100% - 8px
          );

        min-height:
          ${MIN_IMAGE_H}px;

        object-fit:
          fill;

        opacity:
          .92;

        filter:
          saturate(.92)
          contrast(.98);

        pointer-events:
          none;

        border-radius:
          2px;
      }


      #css-minimap-preview
      .css-mini-placeholder {

        position:
          absolute;

        left: 4px;

        right: 4px;

        min-height:
          ${MIN_IMAGE_H}px;

        border-radius:
          2px;

        background:
          rgba(
            255,
            255,
            255,
            .07
          );

        pointer-events:
          none;
      }


      #css-minimap-viewport {

        position:
          absolute;

        left:
          1px;

        right:
          1px;

        top: 0;

        height:
          80px;

        border:
          2px solid
          rgba(
            255,
            255,
            255,
            .96
          );

        background:
          rgba(
            80,
            150,
            255,
            .18
          );

        box-shadow:
          0 0 0 1px
          rgba(
            0,
            0,
            0,
            .30
          ),

          0 4px 18px
          rgba(
            0,
            0,
            0,
            .24
          );

        border-radius:
          8px;

        box-sizing:
          border-box;

        cursor:
          grab;

        pointer-events:
          auto;

        touch-action:
          none;

        /*
         * 중요:
         * transform transition 없음.
         *
         * 스크롤 위치를 완전히
         * 실시간으로 따라가도록 함.
         */
        transition:
          background .12s ease,
          border-color .12s ease;
      }


      #css-minimap-viewport::before {

        content: "";

        position:
          absolute;

        left:
          50%;

        top:
          50%;

        width:
          34px;

        height:
          5px;

        transform:
          translate(
            -50%,
            -50%
          );

        border-top:
          2px solid
          rgba(
            255,
            255,
            255,
            .86
          );

        border-bottom:
          2px solid
          rgba(
            255,
            255,
            255,
            .86
          );

        opacity:
          .88;
      }


      #css-minimap-track:hover
      #css-minimap-viewport {

        background:
          rgba(
            80,
            150,
            255,
            .26
          );

        border-color:
          #fff;
      }


      #css-minimap-viewport
      .css-dragging {

        cursor:
          grabbing;
      }


      #css-minimap-viewport.css-dragging {

        cursor:
          grabbing;

        background:
          rgba(
            80,
            150,
            255,
            .33
          );
      }


      #css-minimap-percent {

        position:
          absolute;

        right:
          calc(
            100% + 8px
          );

        top:
          50%;

        transform:
          translateY(
            -50%
          );

        padding:
          5px 7px;

        border-radius:
          7px;

        background:
          rgba(
            8,
            10,
            14,
            .80
          );

        border:
          1px solid
          rgba(
            255,
            255,
            255,
            .16
          );

        box-shadow:
          0 6px 18px
          rgba(
            0,
            0,
            0,
            .24
          );

        color:
          #fff;

        font-size:
          12px;

        font-weight:
          700;

        letter-spacing:
          .2px;

        white-space:
          nowrap;

        opacity:
          0;

        transition:
          opacity .12s ease;

        pointer-events:
          none;
      }


      #css-minimap-track:hover
      #css-minimap-percent,

      #css-minimap-viewport.css-dragging
      #css-minimap-percent {

        opacity:
          1;
      }


      #css-minimap-hud {

        width:
          ${HUD_WIDTH}px;

        flex:
          0 0 auto;

        padding:
          11px 12px 10px;

        box-sizing:
          border-box;

        border-radius:
          12px;

        background:
          rgba(
            10,
            12,
            16,
            .68
          );

        border:
          1px solid
          rgba(
            255,
            255,
            255,
            .14
          );

        box-shadow:
          0 10px 30px
          rgba(
            0,
            0,
            0,
            .28
          );

        backdrop-filter:
          blur(12px)
          saturate(120%);

        -webkit-backdrop-filter:
          blur(12px)
          saturate(120%);

        pointer-events:
          auto;

        user-select:
          none;
      }


      .css-hud-title {

        display:
          flex;

        align-items:
          center;

        justify-content:
          space-between;

        margin-bottom:
          8px;

        font-size:
          11px;

        font-weight:
          800;

        letter-spacing:
          .9px;

        color:
          rgba(
            255,
            255,
            255,
            .70
          );

        text-transform:
          uppercase;
      }


      .css-hud-row {

        height:
          28px;

        display:
          grid;

        grid-template-columns:
          1fr auto;

        align-items:
          center;

        gap:
          8px;

        padding:
          0 4px;

        border-radius:
          7px;

        transition:
          background .2s ease;
      }


      .css-hud-row.css-flash {

        background:
          rgba(
            80,
            150,
            255,
            .26
          );
      }


      .css-hud-label {

        font-size:
          12px;

        color:
          rgba(
            255,
            255,
            255,
            .72
          );
      }


      .css-hud-value-wrap {

        display:
          flex;

        align-items:
          center;

        gap:
          6px;
      }


      .css-hud-value {

        min-width:
          58px;

        text-align:
          right;

        font-size:
          12px;

        font-variant-numeric:
          tabular-nums;

        font-weight:
          700;

        color:
          rgba(
            255,
            255,
            255,
            .96
          );
      }


      .css-hud-btn {

        width:
          23px;

        height:
          23px;

        padding: 0;

        border:
          1px solid
          rgba(
            255,
            255,
            255,
            .13
          );

        border-radius:
          6px;

        background:
          rgba(
            255,
            255,
            255,
            .07
          );

        color:
          rgba(
            255,
            255,
            255,
            .90
          );

        font:
          700 15px/21px
          ui-sans-serif,
          system-ui,
          sans-serif;

        cursor:
          pointer;
      }


      .css-hud-btn:hover {

        background:
          rgba(
            255,
            255,
            255,
            .15
          );

        border-color:
          rgba(
            255,
            255,
            255,
            .25
          );
      }


      .css-hud-btn:active {

        transform:
          translateY(1px);
      }
    `;


    document.documentElement
      .appendChild(style);
  }


  /** =========================================================
   * UI 생성
   * ======================================================= */

  function createUi() {

    injectStyles();


    minimapRoot =
      document.createElement(
        'div'
      );

    minimapRoot.id =
      'css-minimap-root';


    minimapTrack =
      document.createElement(
        'div'
      );

    minimapTrack.id =
      'css-minimap-track';


    minimapPreview =
      document.createElement(
        'div'
      );

    minimapPreview.id =
      'css-minimap-preview';


    minimapViewport =
      document.createElement(
        'div'
      );

    minimapViewport.id =
      'css-minimap-viewport';


    minimapPercent =
      document.createElement(
        'div'
      );

    minimapPercent.id =
      'css-minimap-percent';

    minimapPercent.textContent =
      '0.0%';


    minimapViewport.appendChild(
      minimapPercent
    );


    minimapTrack.append(
      minimapPreview,
      minimapViewport
    );


    hud =
      document.createElement(
        'div'
      );

    hud.id =
      'css-minimap-hud';


    hud.innerHTML = `

      <div class="css-hud-title">

        <span>
          Scroll Control
        </span>

        <span>
          Minimap
        </span>

      </div>


      <div
        class="css-hud-row"
        data-row="distance"
      >

        <span class="css-hud-label">
          Space
        </span>

        <span class="css-hud-value-wrap">

          <button
            class="css-hud-btn"
            data-action="px-minus"
          >
            −
          </button>

          <span
            class="css-hud-value"
            data-value="distance"
          ></span>

          <button
            class="css-hud-btn"
            data-action="px-plus"
          >
            +
          </button>

        </span>

      </div>


      <div
        class="css-hud-row"
        data-row="up"
      >

        <span class="css-hud-label">
          Shift+Space
        </span>

        <span
          class="css-hud-value"
          data-value="up"
        ></span>

      </div>


      <div
        class="css-hud-row"
        data-row="duration"
      >

        <span class="css-hud-label">
          Smooth
        </span>

        <span class="css-hud-value-wrap">

          <button
            class="css-hud-btn"
            data-action="dur-minus"
          >
            −
          </button>

          <span
            class="css-hud-value"
            data-value="duration"
          ></span>

          <button
            class="css-hud-btn"
            data-action="dur-plus"
          >
            +
          </button>

        </span>

      </div>


      <div
        class="css-hud-row"
        data-row="position"
      >

        <span class="css-hud-label">
          Position
        </span>

        <span
          class="css-hud-value"
          data-value="position"
        ></span>

      </div>
    `;


    minimapRoot.append(
      minimapTrack,
      hud
    );


    document.documentElement
      .appendChild(
        minimapRoot
      );


    hudRows = {

      distance:
        hud.querySelector(
          '[data-row="distance"]'
        ),

      duration:
        hud.querySelector(
          '[data-row="duration"]'
        )
    };


    hud.addEventListener(
      'click',
      (e) => {

        const btn =
          e.target.closest?.(
            '[data-action]'
          );

        if (!btn) {
          return;
        }


        e.preventDefault();
        e.stopPropagation();


        switch (
          btn.dataset.action
        ) {

          case 'px-minus':

            setPx(
              getPx() -
                STEP_PX
            );

            break;


          case 'px-plus':

            setPx(
              getPx() +
                STEP_PX
            );

            break;


          case 'dur-minus':

            setDuration(
              getDuration() -
                STEP_DURATION
            );

            break;


          case 'dur-plus':

            setDuration(
              getDuration() +
                STEP_DURATION
            );

            break;
        }
      }
    );


    minimapTrack
      .addEventListener(
        'pointerdown',
        onMinimapPointerDown
      );


    minimapTrack
      .addEventListener(
        'wheel',
        (e) => {

          e.preventDefault();


          const target =
            primaryTarget ||
            getPrimaryScrollTarget();


          const metrics =
            getScrollMetrics(
              target
            );


          if (metrics.isDoc) {

            window.scrollBy(
              0,
              e.deltaY
            );

          } else {

            metrics.el.scrollTop +=
              e.deltaY;
          }


          requestMinimapUpdate();
        },
        {
          passive: false
        }
      );


    updateHud();
  }


  /** =========================================================
   * HUD
   * ======================================================= */

  function flashHudRow(name) {

    const row =
      hudRows[name];

    if (!row) {
      return;
    }


    row.classList.remove(
      'css-flash'
    );


    void row.offsetWidth;


    row.classList.add(
      'css-flash'
    );


    setTimeout(
      () => {

        row.classList.remove(
          'css-flash'
        );

      },
      420
    );
  }


  function updateHud() {

    if (!hud) {
      return;
    }


    const down =
      getPx();


    const up =
      Math.max(
        1,
        Math.floor(
          down / 2
        )
      );


    const dur =
      getDuration();


    hud.querySelector(
      '[data-value="distance"]'
    ).textContent =
      `${down}px`;


    hud.querySelector(
      '[data-value="up"]'
    ).textContent =
      `${up}px`;


    hud.querySelector(
      '[data-value="duration"]'
    ).textContent =
      `${dur}ms`;
  }


  /** =========================================================
   * 이미지 탐색
   * ======================================================= */

  function getImageSource(img) {

    return (
      img.currentSrc ||
      img.getAttribute(
        'data-src'
      ) ||
      img.getAttribute(
        'data-original'
      ) ||
      img.getAttribute(
        'data-lazy-src'
      ) ||
      img.src ||
      ''
    );
  }


  function getImageDocumentRect(
    img,
    metrics
  ) {

    const r =
      img.getBoundingClientRect();


    if (
      r.width <= 0 ||
      r.height <= 0
    ) {
      return null;
    }


    if (metrics.isDoc) {

      return {

        top:
          r.top +
          metrics.scrollTop,

        left:
          r.left,

        width:
          r.width,

        height:
          r.height
      };
    }


    const tr =
      metrics.el
        .getBoundingClientRect();


    return {

      top:
        r.top -
        tr.top +
        metrics.scrollTop,

      left:
        r.left -
        tr.left,

      width:
        r.width,

      height:
        r.height
    };
  }


  function collectPreviewImages(
    metrics
  ) {

    const scope =
      metrics.isDoc
        ? document
        : metrics.el;


    const imgs =
      Array.from(
        scope.querySelectorAll(
          'img'
        )
      );


    const out = [];


    for (
      const img of imgs
    ) {

      if (
        img.closest(
          '#css-minimap-root'
        )
      ) {
        continue;
      }


      const rect =
        getImageDocumentRect(
          img,
          metrics
        );


      if (!rect) {
        continue;
      }


      if (
        rect.width <
          MIN_SOURCE_WIDTH ||
        rect.height <
          MIN_SOURCE_HEIGHT
      ) {
        continue;
      }


      const style =
        getComputedStyle(img);


      if (
        style.display ===
          'none' ||
        style.visibility ===
          'hidden' ||
        parseFloat(
          style.opacity || '1'
        ) <= 0.01
      ) {
        continue;
      }


      if (
        rect.top +
          rect.height < 0 ||
        rect.top >
          metrics.scrollHeight
      ) {
        continue;
      }


      out.push({

        img,
        rect,

        src:
          getImageSource(
            img
          )
      });
    }


    return out;
  }


  /** =========================================================
   * Minimap 이미지 재구성
   * ======================================================= */

  function findExpandedItemByDocumentY(
    documentY
  ) {

    const items =
      expandedPreviewItems;


    if (items.length === 0) {
      return -1;
    }


    let lo = 0;
    let hi = items.length - 1;


    while (lo < hi) {

      const mid =
        (lo + hi) >> 1;


      if (
        documentY <=
          items[mid].docBottom
      ) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }


    return lo;
  }


  function mapDocumentYToExpandedPreviewY(
    documentY
  ) {

    if (
      !expandedPreviewMode ||
      expandedPreviewItems.length === 0
    ) {
      return 0;
    }


    const items =
      expandedPreviewItems;


    const first =
      items[0];

    const last =
      items[
        items.length - 1
      ];


    if (
      documentY <=
        first.docTop
    ) {
      return first.miniTop;
    }


    if (
      documentY >=
        last.docBottom
    ) {
      return last.miniBottom;
    }


    const index =
      findExpandedItemByDocumentY(
        documentY
      );


    if (index < 0) {
      return 0;
    }


    const item =
      items[index];


    // 이미지 사이의 실제 문서 여백에 위치한 경우.
    if (
      documentY <
        item.docTop &&
      index > 0
    ) {

      const prev =
        items[index - 1];


      const gapDoc =
        Math.max(
          1,
          item.docTop -
            prev.docBottom
        );


      const t =
        clamp(
          (
            documentY -
            prev.docBottom
          ) / gapDoc,
          0,
          1
        );


      return (
        prev.miniBottom +
        (
          item.miniTop -
          prev.miniBottom
        ) * t
      );
    }


    const docH =
      Math.max(
        1,
        item.docBottom -
          item.docTop
      );


    const t =
      clamp(
        (
          documentY -
          item.docTop
        ) / docH,
        0,
        1
      );


    return (
      item.miniTop +
      (
        item.miniBottom -
        item.miniTop
      ) * t
    );
  }


  function findExpandedFirstVisibleIndex(
    miniY
  ) {

    const items =
      expandedPreviewItems;


    if (items.length === 0) {
      return -1;
    }


    let lo = 0;
    let hi = items.length - 1;


    while (lo < hi) {

      const mid =
        (lo + hi) >> 1;


      if (
        items[mid].miniBottom >=
          miniY
      ) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }


    return lo;
  }


  function findExpandedLastVisibleIndex(
    miniY
  ) {

    const items =
      expandedPreviewItems;


    if (items.length === 0) {
      return -1;
    }


    let lo = 0;
    let hi = items.length - 1;


    while (lo < hi) {

      const mid =
        Math.ceil(
          (lo + hi) / 2
        );


      if (
        items[mid].miniTop <=
          miniY
      ) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }


    return lo;
  }


  function createExpandedPreviewNode(
    item
  ) {

    let node;


    if (item.src) {

      node =
        document.createElement(
          'img'
        );


      node.className =
        'css-mini-img';


      // src보다 먼저 설정해야 lazy hint가 확실히 적용된다.
      node.loading =
        'lazy';


      node.decoding =
        'async';


      try {
        node.fetchPriority =
          'low';
      } catch {}


      node.src =
        item.src;


      node.alt = '';


      node.addEventListener(
        'error',
        () => {

          node.style.display =
            'none';

        },
        {
          once: true
        }
      );

    } else {

      node =
        document.createElement(
          'div'
        );


      node.className =
        'css-mini-placeholder';
    }


    return node;
  }


  function renderExpandedPreviewWindow(
    offsetY,
    force = false
  ) {

    if (
      !expandedPreviewMode ||
      !minimapPreview ||
      expandedPreviewItems.length === 0
    ) {
      return;
    }


    const trackH =
      Math.max(
        1,
        minimapTrack?.clientHeight || 1
      );


    const buffer =
      trackH *
      EXPANDED_RENDER_BUFFER_TRACKS;


    const windowStart =
      Math.max(
        0,
        offsetY - buffer
      );


    const windowEnd =
      Math.min(
        expandedPreviewHeight,
        offsetY +
          trackH +
          buffer
      );


    const startIndex =
      findExpandedFirstVisibleIndex(
        windowStart
      );


    const endIndex =
      findExpandedLastVisibleIndex(
        windowEnd
      );


    if (
      startIndex < 0 ||
      endIndex < startIndex
    ) {
      return;
    }


    if (
      force ||
      !expandedRenderLayer ||
      startIndex !==
        expandedRenderStart ||
      endIndex !==
        expandedRenderEnd
    ) {

      const layer =
        document.createElement(
          'div'
        );


      layer.className =
        'css-expanded-layer';


      layer.style.position =
        'absolute';

      layer.style.left =
        '0';

      layer.style.right =
        '0';

      layer.style.top =
        '0';

      layer.style.pointerEvents =
        'none';

      layer.style.willChange =
        'transform';


      expandedRenderBaseY =
        expandedPreviewItems[
          startIndex
        ].miniTop;


      const frag =
        document.createDocumentFragment();


      for (
        let i = startIndex;
        i <= endIndex;
        i++
      ) {

        const item =
          expandedPreviewItems[i];


        const node =
          createExpandedPreviewNode(
            item
          );


        node.style.top =
          `${item.miniTop -
            expandedRenderBaseY}px`;


        node.style.height =
          `${Math.max(
            MIN_IMAGE_H,
            item.miniBottom -
              item.miniTop
          )}px`;


        frag.appendChild(
          node
        );
      }


      layer.appendChild(
        frag
      );


      minimapPreview
        .replaceChildren(
          layer
        );


      expandedRenderLayer =
        layer;

      expandedRenderStart =
        startIndex;

      expandedRenderEnd =
        endIndex;
    }


    expandedRenderLayer.style.transform =
      `translate3d(0, ${expandedRenderBaseY - offsetY}px, 0)`;
  }


  function resetExpandedPreviewState() {

    expandedPreviewMode = false;
    expandedPreviewItems = [];
    expandedPreviewHeight = 0;
    expandedPreviewOffsetY = 0;
    expandedMetricsSnapshot = null;

    expandedRenderStart = -1;
    expandedRenderEnd = -1;
    expandedRenderBaseY = 0;
    expandedRenderLayer = null;

    if (minimapPreview) {

      minimapPreview.classList.remove(
        'css-expanded'
      );

      minimapPreview.style.height = '';
      minimapPreview.style.bottom = '';
      minimapPreview.style.transform = '';
    }
  }


  function rebuildMinimap() {

    if (
      !minimapTrack ||
      !document.documentElement
        .contains(
          minimapTrack
        )
    ) {
      return;
    }


    const newTarget =
      getPrimaryScrollTarget();


    bindPrimaryTarget(
      newTarget
    );


    const metrics =
      getScrollMetrics(
        primaryTarget
      );


    const trackH =
      minimapTrack.clientHeight;


    if (
      trackH <= 0 ||
      metrics.scrollHeight <= 0
    ) {
      return;
    }


    const images =
      collectPreviewImages(
        metrics
      )
        .sort(
          (a, b) =>
            a.rect.top -
            b.rect.top
        );


    /**
     * 먼저 각 이미지를 "미니맵 폭"에 맞춰
     * 종횡비를 유지했을 때 필요한 높이를 계산한다.
     *
     * 그 높이의 합이 실제 미니맵 높이보다 길 때만
     * expanded preview mode를 사용한다.
     */
    const previewInnerWidth =
      Math.max(
        1,
        minimapTrack.clientWidth -
          8
      );


    const prepared =
      images.map(
        (item) => {

          const widthScale =
            previewInnerWidth /
            Math.max(
              1,
              item.rect.width
            );


          return {
            ...item,

            widthScale,

            aspectHeight:
              item.rect.height *
              widthScale
          };
        }
      );


    const fullImageHeight =
      prepared.reduce(
        (sum, item) =>
          sum +
          item.aspectHeight,
        0
      );


    const shouldExpand =
      prepared.length > 0 &&
      fullImageHeight >
        trackH + 1;


    const frag =
      document.createDocumentFragment();


    if (shouldExpand) {

      expandedPreviewMode =
        true;

      expandedPreviewItems =
        [];

      expandedPreviewOffsetY =
        0;

      expandedMetricsSnapshot = {
        scrollHeight:
          metrics.scrollHeight,

        clientHeight:
          metrics.clientHeight,

        maxScroll:
          Math.max(
            0,
            metrics.scrollHeight -
              metrics.clientHeight
          )
      };

      expandedRenderStart = -1;
      expandedRenderEnd = -1;
      expandedRenderBaseY = 0;
      expandedRenderLayer = null;


      let miniCursor = 0;
      let previous = null;


      for (
        const item of prepared
      ) {

        /**
         * 이미지 사이 실제 여백도 가능한 한 보존한다.
         * 웹툰 본문은 보통 0에 가깝기 때문에
         * 다음 장이 바로 아래에 자연스럽게 이어진다.
         */
        if (previous) {

          const gapDoc =
            Math.max(
              0,
              item.rect.top -
              previous.docBottom
            );


          const gapScale =
            (
              previous.widthScale +
              item.widthScale
            ) / 2;


          miniCursor +=
            gapDoc *
            gapScale;
        }


        const miniTop =
          miniCursor;

        const miniHeight =
          Math.max(
            MIN_IMAGE_H,
            item.aspectHeight
          );

        const miniBottom =
          miniTop +
          miniHeight;


        expandedPreviewItems.push(
          {
            docTop:
              item.rect.top,

            docBottom:
              item.rect.top +
              item.rect.height,

            miniTop,
            miniBottom,

            widthScale:
              item.widthScale,

            src:
              item.src
          }
        );


        miniCursor =
          miniBottom;


        previous = {
          docBottom:
            item.rect.top +
            item.rect.height,

          widthScale:
            item.widthScale
        };
      }


      expandedPreviewHeight =
        Math.max(
          trackH,
          miniCursor
        );


      minimapPreview
        .classList.add(
          'css-expanded'
        );


      // preview 자체는 track 크기로 유지한다.
      // 실제 긴 썸네일은 renderExpandedPreviewWindow()가
      // 현재 구간 주변만 가상 렌더링한다.
      minimapPreview.style.bottom = '';
      minimapPreview.style.height = '';
      minimapPreview.style.transform = '';

    } else {

      resetExpandedPreviewState();


      for (
        const item of prepared
      ) {

        const top =
          clamp(
            item.rect.top /
              metrics.scrollHeight *
              trackH,
            0,
            trackH
          );


        const h =
          Math.max(
            MIN_IMAGE_H,
            item.rect.height /
              metrics.scrollHeight *
              trackH
          );


        const maxH =
          Math.max(
            MIN_IMAGE_H,
            trackH - top
          );


        let node;


        if (item.src) {

          node =
            document.createElement(
              'img'
            );


          node.className =
            'css-mini-img';


          node.src =
            item.src;


          node.alt = '';


          node.decoding =
            'async';


          node.loading =
            'eager';


          node.addEventListener(
            'error',
            () => {

              node.style.display =
                'none';

            },
            {
              once: true
            }
          );

        } else {

          node =
            document.createElement(
              'div'
            );


          node.className =
            'css-mini-placeholder';
        }


        node.style.top =
          `${top}px`;


        node.style.height =
          `${Math.min(
            h,
            maxH
          )}px`;


        frag.appendChild(
          node
        );
      }
    }


    minimapPreview
      .replaceChildren(
        frag
      );


    forceMinimapUpdate();
  }


  function markScrollActivity() {

    lastScrollActivityAt =
      performance.now();


    // 이미 rebuild가 예약돼 있다면 스크롤이 끝날 때까지 미룬다.
    if (rebuildTimer !== null) {

      clearTimeout(
        rebuildTimer
      );


      rebuildTimer =
        setTimeout(
          runScheduledRebuild,
          REBUILD_SCROLL_IDLE_MS
        );
    }
  }


  function runScheduledRebuild() {

    rebuildTimer = null;


    const elapsed =
      performance.now() -
      lastScrollActivityAt;


    if (
      elapsed <
        REBUILD_SCROLL_IDLE_MS
    ) {

      rebuildTimer =
        setTimeout(
          runScheduledRebuild,
          Math.max(
            24,
            REBUILD_SCROLL_IDLE_MS -
              elapsed
          )
        );

      return;
    }


    rebuildMinimap();
  }


  function scheduleRebuild(
    delay = 180
  ) {

    clearTimeout(
      rebuildTimer
    );


    const elapsed =
      performance.now() -
      lastScrollActivityAt;


    const scrollIdleWait =
      Math.max(
        0,
        REBUILD_SCROLL_IDLE_MS -
          elapsed
      );


    rebuildTimer =
      setTimeout(
        runScheduledRebuild,
        Math.max(
          delay,
          scrollIdleWait
        )
      );
  }


  /** =========================================================
   * Scroll listener
   * ======================================================= */

  function unbindScrollListeners() {

    if (
      observedScrollEl &&
      elementScrollListener
    ) {

      observedScrollEl
        .removeEventListener(
          'scroll',
          elementScrollListener
        );
    }


    if (
      windowScrollListener
    ) {

      window.removeEventListener(
        'scroll',
        windowScrollListener
      );
    }


    observedScrollEl = null;

    elementScrollListener = null;
    windowScrollListener = null;
  }


  function bindPrimaryTarget(
    target
  ) {

    const metrics =
      getScrollMetrics(
        target
      );


    if (
      primaryTarget === target &&
      observedScrollEl ===
        metrics.el
    ) {
      return;
    }


    unbindScrollListeners();


    primaryTarget =
      target;


    observedScrollEl =
      metrics.el;


    /**
     * ★ 중요 수정
     *
     * Document 스크롤이면
     * scrollingElement가 아니라
     * window scroll을 감시한다.
     */

    if (metrics.isDoc) {

      windowScrollListener =
        () => {

          markScrollActivity();
          requestMinimapUpdate();

        };


      window.addEventListener(
        'scroll',
        windowScrollListener,
        {
          passive: true
        }
      );

    } else {

      elementScrollListener =
        () => {

          markScrollActivity();
          requestMinimapUpdate();

        };


      observedScrollEl
        .addEventListener(
          'scroll',
          elementScrollListener,
          {
            passive: true
          }
        );
    }


    /**
     * 추가 안전망
     *
     * capture 단계에서 모든 scroll을 감지.
     */

    if (resizeObserver) {

      try {

        resizeObserver
          .disconnect();

      } catch {}


      try {

        resizeObserver.observe(
          metrics.el
        );

      } catch {}


      if (
        document.body &&
        metrics.el !==
          document.body
      ) {

        try {

          resizeObserver.observe(
            document.body
          );

        } catch {}
      }
    }
  }


  /** =========================================================
   * 현재 viewport 표시
   * ======================================================= */

  function updateMinimapViewport() {

    if (
      !minimapTrack ||
      !minimapViewport
    ) {
      return;
    }


    const target =
      primaryTarget ||
      getPrimaryScrollTarget();


    const metrics =
      getScrollMetrics(
        target
      );


    const trackH =
      minimapTrack.clientHeight;


    if (trackH <= 0) {
      return;
    }


    const liveMaxScroll =
      Math.max(
        0,
        metrics.scrollHeight -
          metrics.clientHeight
      );


    /**
     * 드래그 중에는 시작 순간의 maxScroll을 사용한다.
     * lazy-load로 scrollHeight가 바뀌어도 ratio 기준이
     * 드래그 도중 바뀌지 않게 한다.
     */
    const ratioMaxScroll =
      draggingViewport &&
      dragSession

        ? dragSession.maxScroll

        : (
            expandedPreviewMode &&
            expandedMetricsSnapshot

              ? expandedMetricsSnapshot.maxScroll
              : liveMaxScroll
          );


    const ratio =
      ratioMaxScroll > 0

        ? clamp(
            metrics.scrollTop /
              ratioMaxScroll,
            0,
            1
          )

        : 0;


    let rawViewportH;


    /**
     * 드래그 중 viewport 높이까지 고정한다.
     * 특히 웹툰 마지막 이미지 아래쪽에서 mapping 결과가
     * MIN_VIEWPORT_H로 수렴하며 핸들 높이가 바뀌는 것을 막는다.
     */
    if (
      draggingViewport &&
      dragSession
    ) {

      rawViewportH =
        dragSession.viewportH;

    } else if (
      expandedPreviewMode &&
      expandedPreviewItems.length > 0
    ) {

      const miniStart =
        mapDocumentYToExpandedPreviewY(
          metrics.scrollTop
        );


      const miniEnd =
        mapDocumentYToExpandedPreviewY(
          metrics.scrollTop +
            metrics.clientHeight
        );


      rawViewportH =
        Math.max(
          0,
          miniEnd -
          miniStart
        );

    } else {

      rawViewportH =
        metrics.scrollHeight > 0

          ? (
              metrics.clientHeight /
              metrics.scrollHeight
            ) * trackH

          : trackH;
    }


    const viewportH =
      draggingViewport &&
      dragSession

        ? clamp(
            dragSession.viewportH,
            MIN_VIEWPORT_H,
            trackH
          )

        : clamp(
            rawViewportH,
            MIN_VIEWPORT_H,
            trackH
          );


    const maxViewportTop =
      draggingViewport &&
      dragSession

        ? dragSession.maxViewportTop

        : Math.max(
            0,
            trackH -
              viewportH
          );


    const top =
      clamp(
        ratio *
          maxViewportTop,
        0,
        maxViewportTop
      );


    /**
     * expanded mode에서는 viewport의 전체 문서상 위치는
     * percentage 위치를 유지하고,
     * 뒤의 이미지 스트립만 움직여 현재 실제 이미지가
     * viewport 아래에 오도록 맞춘다.
     */
    if (
      expandedPreviewMode &&
      expandedPreviewItems.length > 0
    ) {

      const currentMiniY =
        mapDocumentYToExpandedPreviewY(
          metrics.scrollTop
        );


      const maxPreviewOffset =
        Math.max(
          0,
          expandedPreviewHeight -
            trackH
        );


      expandedPreviewOffsetY =
        clamp(
          currentMiniY -
            top,
          0,
          maxPreviewOffset
        );


      renderExpandedPreviewWindow(
        expandedPreviewOffsetY
      );

    } else if (minimapPreview) {

      expandedPreviewOffsetY =
        0;


      minimapPreview.style.transform =
        '';
    }


    minimapViewport.style.height =
      `${viewportH}px`;


    minimapViewport.style.transform =
      `translate3d(0, ${top}px, 0)`;


    const percent =
      ratio * 100;


    minimapPercent.textContent =
      `${percent.toFixed(1)}%`;


    const posEl =
      hud?.querySelector(
        '[data-value="position"]'
      );


    if (posEl) {

      posEl.textContent =
        `${percent.toFixed(1)}%`;
    }
  }


  /** =========================================================
   * Minimap → 실제 스크롤
   * ======================================================= */

  function scrollFromMinimapY(
    clientY,
    preserveGrabOffset = false
  ) {

    if (!primaryTarget) {

      primaryTarget =
        getPrimaryScrollTarget();
    }


    const metrics =
      getScrollMetrics(
        primaryTarget
      );


    let trackTop;
    let trackH;
    let viewportH;
    let maxViewportTop;
    let grabOffsetY;
    let maxScroll;


    /**
     * pointer drag 중에는 pointerdown 시점에 저장한 geometry만 사용.
     * getBoundingClientRect()/scrollHeight가 도중에 바뀌어도
     * pointer → scroll ratio가 흔들리지 않는다.
     */
    if (
      preserveGrabOffset &&
      draggingViewport &&
      dragSession
    ) {

      trackTop =
        dragSession.trackTop;

      trackH =
        dragSession.trackH;

      viewportH =
        dragSession.viewportH;

      maxViewportTop =
        dragSession.maxViewportTop;

      grabOffsetY =
        dragSession.grabOffsetY;

      maxScroll =
        dragSession.maxScroll;

    } else {

      const rect =
        minimapTrack
          .getBoundingClientRect();


      trackTop =
        rect.top;

      trackH =
        rect.height;


      viewportH =
        minimapViewport
          .getBoundingClientRect()
          .height;


      maxViewportTop =
        Math.max(
          0,
          trackH -
            viewportH
        );


      grabOffsetY =
        preserveGrabOffset

          ? dragOffsetY
          : viewportH / 2;


      maxScroll =
        Math.max(
          0,
          metrics.scrollHeight -
            metrics.clientHeight
        );
    }


    let y =
      clientY -
      trackTop -
      grabOffsetY;


    const viewportTop =
      clamp(
        y,
        0,
        maxViewportTop
      );


    // 끝점은 정확히 0/1로 고정해 부동소수점 흔들림도 없앤다.
    let ratio;


    if (maxViewportTop <= 0) {

      ratio = 0;

    } else if (viewportTop <= 0) {

      ratio = 0;

    } else if (
      viewportTop >=
        maxViewportTop
    ) {

      ratio = 1;

    } else {

      ratio =
        viewportTop /
        maxViewportTop;
    }


    const newTop =
      ratio *
      maxScroll;


    if (dragSession) {

      dragSession.lastRatio =
        ratio;
    }


    /**
     * 이미 같은 끝점에 있는데 pointer가 track 아래로 더 내려가도
     * scrollTo()를 반복 호출하지 않는다.
     * 맨 아래에서 발생하던 scroll event ↔ viewport update 루프 차단.
     */
    if (
      Math.abs(
        metrics.scrollTop -
          newTop
      ) <= 0.5
    ) {
      return;
    }


    if (metrics.isDoc) {

      window.scrollTo(
        0,
        newTop
      );

    } else {

      metrics.el.scrollTop =
        newTop;
    }


    forceMinimapUpdate();
  }


  /** =========================================================
   * Minimap pointer drag
   * ======================================================= */

  function onMinimapPointerDown(
    e
  ) {

    if (e.button !== 0) {
      return;
    }


    e.preventDefault();
    e.stopPropagation();


    const viewportRect =
      minimapViewport
        .getBoundingClientRect();


    const trackRect =
      minimapTrack
        .getBoundingClientRect();


    const metrics =
      getScrollMetrics(
        primaryTarget ||
        getPrimaryScrollTarget()
      );


    const onViewport =
      e.clientY >=
        viewportRect.top &&
      e.clientY <=
        viewportRect.bottom;


    draggingViewport =
      true;


    minimapViewport
      .classList.add(
        'css-dragging'
      );


    if (onViewport) {

      dragOffsetY =
        e.clientY -
        viewportRect.top;

    } else {

      dragOffsetY =
        viewportRect.height /
        2;
    }


    const frozenMaxScroll =
      Math.max(
        0,
        metrics.scrollHeight -
          metrics.clientHeight
      );


    dragSession = {

      trackTop:
        trackRect.top,

      trackH:
        trackRect.height,

      viewportH:
        viewportRect.height,

      maxViewportTop:
        Math.max(
          0,
          trackRect.height -
            viewportRect.height
        ),

      grabOffsetY:
        dragOffsetY,

      maxScroll:
        frozenMaxScroll,

      lastRatio:
        null
    };


    /**
     * expanded snapshot의 ratio 기준도 drag 시작 시점과 맞춘다.
     * drag 종료 순간 예전 snapshot으로 되돌아가 한 번 튀는 현상 방지.
     */
    if (
      expandedPreviewMode &&
      expandedMetricsSnapshot
    ) {

      expandedMetricsSnapshot.scrollHeight =
        metrics.scrollHeight;

      expandedMetricsSnapshot.clientHeight =
        metrics.clientHeight;

      expandedMetricsSnapshot.maxScroll =
        frozenMaxScroll;
    }


    if (!onViewport) {

      scrollFromMinimapY(
        e.clientY,
        true
      );
    }


    minimapTrack
      .setPointerCapture?.(
        e.pointerId
      );


    const move = (ev) => {

      if (
        !draggingViewport
      ) {
        return;
      }


      scrollFromMinimapY(
        ev.clientY,
        true
      );
    };


    const up = (ev) => {

      draggingViewport =
        false;


      minimapViewport
        .classList.remove(
          'css-dragging'
        );


      // drag geometry lock 해제. 실제 문서 높이는 idle rebuild에서 반영한다.
      dragSession = null;


      try {

        minimapTrack
          .releasePointerCapture?.(
            ev.pointerId
          );

      } catch {}


      minimapTrack
        .removeEventListener(
          'pointermove',
          move
        );


      minimapTrack
        .removeEventListener(
          'pointerup',
          up
        );


      minimapTrack
        .removeEventListener(
          'pointercancel',
          up
        );


      // lazy-load로 바뀐 실제 높이는 드래그가 끝난 다음 한 번만 반영한다.
      scheduleRebuild(
        120
      );

      requestMinimapUpdate();
    };


    minimapTrack
      .addEventListener(
        'pointermove',
        move
      );


    minimapTrack
      .addEventListener(
        'pointerup',
        up
      );


    minimapTrack
      .addEventListener(
        'pointercancel',
        up
      );
  }


  /** =========================================================
   * 페이지 변화 감시
   * ======================================================= */

  function installObservers() {

    mutationObserver =
      new MutationObserver(
        (mutations) => {

          let relevant = false;


          for (
            const m of mutations
          ) {

            if (
              m.target
                ?.closest?.(
                  '#css-minimap-root'
                )
            ) {
              continue;
            }


            relevant = true;

            break;
          }


          if (relevant) {

            scheduleRebuild(
              260
            );
          }
        }
      );


    mutationObserver.observe(
      document.documentElement,
      {

        subtree: true,

        childList: true,

        attributes: true,

        attributeFilter: [
          'src',
          'srcset',
          'style',
          'class'
        ]
      }
    );


    resizeObserver =
      new ResizeObserver(
        () => {

          scheduleRebuild(
            140
          );

        }
      );


    document.addEventListener(
      'load',
      (e) => {

        if (
          e.target instanceof
            HTMLImageElement &&
          !e.target.closest(
            '#css-minimap-root'
          )
        ) {

          scheduleRebuild(
            100
          );
        }
      },
      true
    );


    window.addEventListener(
      'resize',
      () => {

        scheduleRebuild(
          120
        );

      },
      {
        passive: true
      }
    );


    /**
     * 모든 nested scroll container도
     * 실시간 추적하는 안전망.
     *
     * scroll은 bubble하지 않지만
     * capture 단계에서는 잡을 수 있음.
     */

    document.addEventListener(
      'scroll',
      () => {

        markScrollActivity();
        requestMinimapUpdate();

      },
      {
        capture: true,
        passive: true
      }
    );
  }


  /** =========================================================
   * 키 처리
   * ======================================================= */

  function installKeyboardHandlers() {

    addEventListener(
      'keydown',
      (e) => {

        /** Space */

        if (
          e.code === 'Space'
        ) {

          if (e.isComposing) {
            return;
          }


          const active =
            document.activeElement;


          if (
            isTypingContext(
              active
            )
          ) {
            return;
          }


          e.preventDefault();
          e.stopPropagation();


          const down =
            getPx();


          const upHalf =
            -Math.max(
              1,
              Math.floor(
                down / 2
              )
            );


          const amount =
            e.shiftKey
              ? upHalf
              : down;


          doScroll(
            amount
          );


          return;
        }


        /** Alt */

        if (
          e.altKey &&
          !e.ctrlKey &&
          !e.metaKey
        ) {

          const active =
            document.activeElement;


          if (
            isTypingContext(
              active
            )
          ) {
            return;
          }


          let handled =
            false;


          if (
            e.key ===
            'ArrowUp'
          ) {

            setPx(
              getPx() +
                STEP_PX
            );

            handled =
              true;
          }


          else if (
            e.key ===
            'ArrowDown'
          ) {

            setPx(
              getPx() -
                STEP_PX
            );

            handled =
              true;
          }


          else if (
            e.key === '0'
          ) {

            setPx(
              DEFAULT_PX
            );

            handled =
              true;
          }


          else if (
            e.key === '.'
          ) {

            setDuration(
              getDuration() +
                STEP_DURATION
            );

            handled =
              true;
          }


          else if (
            e.key === ','
          ) {

            setDuration(
              getDuration() -
                STEP_DURATION
            );

            handled =
              true;
          }


          else if (
            e.key === '9'
          ) {

            setDuration(
              DEFAULT_DURATION
            );

            handled =
              true;
          }


          if (handled) {

            e.preventDefault();

            e.stopPropagation();
          }
        }
      },
      {
        capture: true
      }
    );
  }


  /** =========================================================
   * 초기화
   * ======================================================= */

  createUi();

  installKeyboardHandlers();

  installObservers();

  bindPrimaryTarget(
    getPrimaryScrollTarget()
  );

  scheduleRebuild(0);

})();
})();
