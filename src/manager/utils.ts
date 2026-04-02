/** @file Provides various utility functions used withing signal handling code. */

import type Clutter from 'gi://Clutter';
import type {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import type {Bounds, RoundedCornerSettings} from '../utils/types.js';

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';
import GLib from 'gi://GLib';

import {boxShadowCss} from '../utils/box_shadow.js';
import {
    APP_SHADOWS,
    ROUNDED_CORNERS_EFFECT,
    SHADOW_PADDING,
} from '../utils/constants.js';
import {readFile} from '../utils/file.js';
import {logDebug} from '../utils/log.js';
import {getPref} from '../utils/settings.js';

let padsi_zones_file = "/run/padsi/zones-infos/colors.json";
let padsi_namespaces: Record<string, [number, number, number]> = {};

function load(path: string): string | null {
    try {
        const file = Gio.File.new_for_path(path);
        const [, contents] = file.load_contents(null);
        const decoder = new TextDecoder("utf-8");
        return decoder.decode(contents);
    } catch (e) {
        logDebug(`JSON file ${padsi_zones_file} not yet present`);
        return null;
    }
}

function get_ppid(pid: number): number | null | undefined {
    const path = `/proc/${pid}/stat`;
    let st = load(path);
    if (st == null) return null;
    let parts = st.split(")");
    if (parts.length != 2) {
        logDebug(`Missing command in parenthesis in '${path}' contents '${st}'`);
        return undefined;
    }

    parts = parts[1].trim().split(" ");
    const ppid = parseInt(parts[1]);
    if (ppid == 0) return null;
    return ppid;
}

function get_namespaces(pid: number): string[] | undefined {
    let res: string[] = [];
    let lpid: number | null | undefined = pid;
    while (lpid != null) {
        try {
            const mnt = GLib.file_read_link(`/proc/${lpid}/ns/mnt`);
            const net = GLib.file_read_link(`/proc/${lpid}/ns/net`);
            const ns = mnt + net;
            if (!res.includes(ns)) res.push(ns);
        } catch (e) {
          //logDebug(`Could not readlink PID '${lpid}' namespaces: '${e}'`);
          // we may get some permission denied errors
        }
        lpid = get_ppid(lpid);
        if (lpid === undefined) return undefined;
    }
    logDebug(`Namespaces for PID ${pid}: ${res}`);
    return res;
}

function remove_border(cfg: RoundedCornerSettings): RoundedCornerSettings {
    let ncfg = { ...cfg };
    ncfg.borderColor[3] = 0;
    return ncfg;
}
/*
 * Get the border color of a window using the namespace of the PID which "owns" the window
 * and the padsi_namespaces variable's values.
 *
 * The transparency component of the returned value is taken from the settings_border_color variable
 * which represents the current global extension's settings.
 */
function get_border_color(
    win: Meta.Window,
    cfg: RoundedCornerSettings,
): RoundedCornerSettings {
    let pid = win.get_pid();
    let namespaces = get_namespaces(pid);

    if (namespaces === undefined) {
        logDebug(`Could not determine namespaces of PID ${pid}`);
        return remove_border(cfg);
    }

    // try to find a matching color for the namespace
    for (var i = 0; i < namespaces.length; i++) {
        const colors = padsi_namespaces[namespaces[i]];
        if (colors !== undefined) {
            logDebug("Found border color for PID " + pid + ": " + colors);
            let scfg = { ...cfg };
            scfg.borderColor[0] = colors[0];
            scfg.borderColor[1] = colors[1];
            scfg.borderColor[2] = colors[2];
            return scfg;
        }
    }

    // reload the PADSI namespaces
    try {
        let data = load(padsi_zones_file);
        if (data == null) {
            padsi_namespaces = {};
            return remove_border(cfg);
        }
        padsi_namespaces = JSON.parse(data);
    } catch (e: any) {
        logError(e);
        padsi_namespaces = {};
        return remove_border(cfg);
    }

    logDebug("Reloaded namespaces's colors");
    // try again to find a matching color for the namespace
    for (var i = 0; i < namespaces.length; i++) {
        const colors = padsi_namespaces[namespaces[i]];
        if (colors !== undefined) {
            logDebug("Found border color for PID " + pid + ": " + colors);
            let scfg = { ...cfg };
            scfg.borderColor[0] = colors[0];
            scfg.borderColor[1] = colors[1];
            scfg.borderColor[2] = colors[2];
            return scfg;
        }
    }

    return remove_border(cfg);
}

// Cache mutter settings to avoid creating a new Gio.Settings object on every
// call to windowScaleFactor (which is called per-frame during overview animations).
let mutterSettings: Gio.Settings | null = null;
let fractionalScalingEnabled: boolean | null = null;

/**
 * Check whether fractional scaling is enabled in the GNOME mutter settings.
 * The result is cached and invalidated when the `experimental-features` setting
 * changes.
 *
 * @returns Whether fractional scaling is currently enabled.
 */
function isFractionalScalingEnabled(): boolean {
    if (mutterSettings === null) {
        mutterSettings = Gio.Settings.new('org.gnome.mutter');
        mutterSettings.connect('changed::experimental-features', () => {
            fractionalScalingEnabled = null;
        });
    }
    if (fractionalScalingEnabled === null) {
        const features = mutterSettings.get_strv('experimental-features');

        // The method doesn't exist on GNOME 50+ because it's Wayland-only
        const isWaylandCompositor =
            !Meta.is_wayland_compositor || Meta.is_wayland_compositor();

        fractionalScalingEnabled =
            isWaylandCompositor &&
            features.includes('scale-monitor-framebuffer');
    }
    return fractionalScalingEnabled;
}

/**
 * Clear the cached mutter settings and fractional scaling state.
 * Should be called when the extension is disabled to release the
 * {@link Gio.Settings} object and its D-Bus signal subscription.
 */
export function clearMutterSettingsCache() {
    mutterSettings = null;
    fractionalScalingEnabled = null;
}

/**
 * Get the actor that rounded corners should be applied to.
 * In Wayland, the effect is applied to WindowActor, but in X11, it is applied
 * to WindowActor.first_child.
 *
 * @param actor - The window actor to unwrap.
 * @returns The correct actor that the effect should be applied to.
 */
export function unwrapActor(actor: Meta.WindowActor): Clutter.Actor | null {
    const type = actor.metaWindow.get_client_type();
    return type === Meta.WindowClientType.X11 ? actor.get_first_child() : actor;
}

/**
 * Get the correct rounded corner setting for a window (custom settings if a
 * window has custom overrides, global settings otherwise).
 *
 * @param win - The window to get the settings for.
 * @returns The matching settings object.
 */
export function getRoundedCornersCfg(win: Meta.Window): RoundedCornerSettings {
    const globalCfg = getPref('global-rounded-corner-settings');
    const customCfgList = getPref('custom-rounded-corner-settings');
    let res = null;
    const wmClass = win.get_wm_class_instance();
    if (
        wmClass == null ||
        !customCfgList[wmClass] ||
        !customCfgList[wmClass].enabled
    ) {
        res = globalCfg;
    } else {
        res = customCfgList[wmClass];
    }

    // adapt the returned setting from the actual window
    return get_border_color(win, res);
}

// Weird TypeScript magic :)
type RoundedCornersEffectType = InstanceType<typeof RoundedCornersEffect>;

/**
 * Get the Clutter.Effect object for the rounded corner effect of a specific
 * window.
 *
 * @param actor - The window actor to get the effect for.
 * @returns The corresponding Clutter.Effect object.
 */
export function getRoundedCornersEffect(
    actor: Meta.WindowActor,
): RoundedCornersEffectType | null {
  const win = actor.metaWindow;
    if (win == null) {
        return null;
    }
    const name = ROUNDED_CORNERS_EFFECT;
    return win.get_client_type() === Meta.WindowClientType.X11
        ? (actor.firstChild.get_effect(name) as RoundedCornersEffectType)
        : (actor.get_effect(name) as RoundedCornersEffectType);
}

/**
 * Get the scaling factor of a window.
 *
 * @param win - The window to get the scaling factor for.
 * @returns The scaling factor of the window.
 */
export function windowScaleFactor(win: Meta.Window) {
    // When fractional scaling is enabled, always return 1.
    // Use cached settings to avoid creating a new Gio.Settings object per call.
    if (isFractionalScalingEnabled()) {
        return 1;
    }

    const monitorIndex = win.get_monitor();
    return global.display.get_monitor_scale(monitorIndex);
}

/** Compute outer bounds for rounded corners of a window
 *
 * @param actor - The window actor to compute the bounds for.
 * @param [x, y, width, height] - The content offsets of the window actor.
 */
export function computeBounds(
    actor: Meta.WindowActor,
    [x, y, width, height]: [number, number, number, number],
): Bounds {
    const bounds = {
        x1: x + 1,
        y1: y + 1,
        x2: x + actor.width + width,
        y2: y + actor.height + height,
    };

    // Kitty draws its window decoration by itself, so we need to manually
    // clip its shadow and recompute the outer bounds for it.
    if (
        getPref('tweak-kitty-terminal') &&
        actor.metaWindow.get_client_type() === Meta.WindowClientType.WAYLAND &&
        actor.metaWindow.get_wm_class_instance() === 'kitty'
    ) {
        const [x1, y1, x2, y2] = APP_SHADOWS.kitty;
        const scale = windowScaleFactor(actor.metaWindow);
        bounds.x1 += x1 * scale;
        bounds.y1 += y1 * scale;
        bounds.x2 -= x2 * scale;
        bounds.y2 -= y2 * scale;
    }

    return bounds;
}

/**
 * Compute the offset of actual window contents from the entire window buffer.
 *
 * @param window - The window to compute the offset for.
 * @returns The content offsets of the window (x, y, width, height).
 */
export function computeWindowContentsOffset(
    window: Meta.Window,
): [number, number, number, number] {
    const bufferRect = window.get_buffer_rect();
    const frameRect = window.get_frame_rect();
    return [
        frameRect.x - bufferRect.x,
        frameRect.y - bufferRect.y,
        frameRect.width - bufferRect.width,
        frameRect.height - bufferRect.height,
    ];
}

/**
 * Compute the offset of the shadow actor for a window.
 *
 * @param actor - The window actor to compute the offset for.
 * @param [offsetX, offsetY, offsetWidth, offsetHeight] - The content offsets of the window actor.
 */
export function computeShadowActorOffset(
    actor: Meta.WindowActor,
    [offsetX, offsetY, offsetWidth, offsetHeight]: [
        number,
        number,
        number,
        number,
    ],
): number[] {
    const win = actor.metaWindow;
    const shadowPadding = SHADOW_PADDING * windowScaleFactor(win);

    return [
        offsetX - shadowPadding,
        offsetY - shadowPadding,
        2 * shadowPadding + offsetWidth,
        2 * shadowPadding + offsetHeight,
    ];
}

/** Update the CSS style of a shadow actor
 *
 * @param win - The window to update the style for.
 * @param actor - The shadow actor to update the style for.
 * @param borderRadius - The border radius of the shadow actor.
 * @param shadow - The shadow settings for the window.
 * @param padding - The padding of the shadow actor.
 */
export function updateShadowActorStyle(
    win: Meta.Window,
    actor: St.Bin,
    borderRadius = getPref('global-rounded-corner-settings').borderRadius,
    shadow = getPref('focused-shadow'),
    padding = getPref('global-rounded-corner-settings').padding,
) {
    const {left, right, top, bottom} = padding;

    // Increase border_radius when smoothing is on.
    // Read global settings once to avoid repeated GSettings deserializations.
    let adjustedBorderRadius = borderRadius;
    const globalCfg = getPref('global-rounded-corner-settings');
    if (globalCfg !== null) {
        adjustedBorderRadius *= 1.0 + globalCfg.smoothing;
    }

    // If there are two monitors with different scale factors, the scale of
    // the window may be different from the scale that has to be applied in
    // the css, so we have to adjust the scale factor accordingly.

    const originalScale = St.ThemeContext.get_for_stage(
        global.stage as Clutter.Stage,
    ).scaleFactor;

    const scale = windowScaleFactor(win) / originalScale;

    actor.style = `padding: ${SHADOW_PADDING * scale}px;`;

    const child = actor.firstChild as St.Bin;

    const hideShadowForMaximizedFullscreen =
        !getPref('keep-shadow-for-maximized-fullscreen') &&
        (win.maximizedHorizontally ||
            win.maximizedVertically ||
            win.fullscreen);

    const newChildStyle = hideShadowForMaximizedFullscreen
        ? 'opacity: 0;'
        : `background: white;
               border-radius: ${adjustedBorderRadius * scale}px;
               ${boxShadowCss(shadow, scale)};
               margin: ${top * scale}px
                       ${right * scale}px
                       ${bottom * scale}px
                       ${left * scale}px;`;

    // Only update style and queue a redraw when the style actually changed.
    if (child.style !== newChildStyle) {
        child.style = newChildStyle;
        child.queue_redraw();
    }
}

/**
 * Check whether a window should have rounded corners.
 *
 * @param win - The window to check.
 * @returns Whether the window should have rounded corners.
 */
export function shouldEnableEffect(
    win: Meta.Window & {_appType?: AppType},
): boolean {
    if (win == null) {
        return false;
    }
    // Skip rounded corners for the DING (Desktop Icons NG) extension.
    //
    // https://extensions.gnome.org/extension/2087/desktop-icons-ng-ding/
    if (win.gtkApplicationId === 'com.rastersoft.ding') {
        return false;
    }

    // Skip maximized/fullscreen windows according to settings.
    const maximized = win.maximizedHorizontally || win.maximizedVertically;
    const fullscreen = win.fullscreen;
    const cfg = getRoundedCornersCfg(win);
    return (
        !(maximized || fullscreen) ||
        (maximized && !fullscreen && cfg.keepRoundedCorners.maximized) ||
        (fullscreen && cfg.keepRoundedCorners.fullscreen)
    );
}

type AppType = 'LibAdwaita' | 'LibHandy' | 'Other';

/**
 * Get the type of the application (LibHandy/LibAdwaita/Other).
 *
 * @param win - The window to get the type of.
 * @returns the type of the application.
 */
function getAppType(win: Meta.Window): AppType {
    try {
        // May throw a permission error.
        const contents = readFile(`/proc/${win.get_pid()}/maps`);

        if (contents.includes('libhandy-1.so')) {
            return 'LibHandy';
        }

        if (contents.includes('libadwaita-1.so')) {
            return 'LibAdwaita';
        }

        return 'Other';
    } catch (e) {
        logError(e);
        return 'Other';
    }
}
