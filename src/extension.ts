import Gio from 'gi://Gio';
import type GObject from 'gi://GObject';

import {
    Extension,
    InjectionManager,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import {layoutManager} from 'resource:///org/gnome/shell/ui/main.js';
import {WindowPreview} from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {WorkspaceAnimationController} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import {disableEffect, enableEffect} from './manager/event_manager.js';
import {clearMutterSettingsCache} from './manager/utils.js';
import {addShadowInOverview} from './patch/add_shadow_in_overview.js';
import {
    addShadowsInWorkspaceSwitch,
    removeShadowsAfterWorkspaceSwitch,
} from './patch/workspace_switch.js';
import {
    disableBackgroundMenuItem,
    enableBackgroundMenuItem,
} from './utils/background_menu.js';
import {logDebug} from './utils/log.js';
import {getPref, initPrefs, prefs, uninitPrefs} from './utils/settings.js';
import { WindowPicker } from './window_picker/service.js';

import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUTTON_LABEL     = 'More...';
const PADSI_UI_PROGRAM   = '/usr/bin/gnome-terminal';
const INDICATOR_ICON_NAME  = 'security-medium-symbolic';


export default class PadsiExtension extends Extension {
    // The extension works by overriding (monkey patching) the code of GNOME
    // Shell's internal methods. InjectionManager is a convenience class that
    // stores references to the original methods and allows to easily restore
    // them when the extension is disabled.
    #injectionManager: InjectionManager | null = null;

    #windowPicker: WindowPicker | null = null;

    #layoutManagerStartupConnection: number | null = null;
    #workspaceSwitchConnections: { object: GObject.Object; id: number }[] | null =
        null;


    _indicator: PanelMenu.Button | null = null;
    _menu_opened: boolean = false;
    _errorLabel: St.Label | null = null;
    _vpnSubmenu: PopupMenu.PopupSubMenuMenuItem | null = null;


    enable() {
        // Initialize extension preferences
        initPrefs(this.getSettings());

        this.#injectionManager = new InjectionManager();

        // Export the d-bus interface of the window picker in preferences.
        // See the readme in the `window_picker` directory for more information.
        this.#windowPicker = new WindowPicker();
        this.#windowPicker.export();

        if (layoutManager._startingUp) {
            // Wait for GNOME Shell to be ready before enabling rounded corners
            this.#layoutManagerStartupConnection = layoutManager.connect(
                'startup-complete',
                () => {
                    enableEffect();

                    if (getPref('enable-preferences-entry')) {
                        enableBackgroundMenuItem();
                    }

                    layoutManager.disconnect(
                        // biome-ignore lint/style/noNonNullAssertion: Since this happens inside of the connection, there is no way for this to be null.
                        this.#layoutManagerStartupConnection!,
                    );
                },
            );
        } else {
            enableEffect();

            if (getPref('enable-preferences-entry')) {
                enableBackgroundMenuItem();
            }
        }

        const self = this;

        // WindowPreview is a widget that shows a window in the overview.
        // We need to override its `_addWindow` method to add a shadow actor
        // to the preview, otherwise overview windows won't have custom
        // shadows.
        this.#injectionManager.overrideMethod(
            WindowPreview.prototype,
            '_addWindow',
            addWindow =>
                function (window) {
                    addWindow.call(this, window);
                    addShadowInOverview(window, this);
                },
        );

        // The same way we applied a cloned shadow actor to window previews in
        // the overview, we also need to apply it to windows during workspace
        // switching.
        this.#injectionManager.overrideMethod(
            WorkspaceAnimationController.prototype,
            '_prepareWorkspaceSwitch',
            prepareWorkspaceSwitch =>
                function (workspaceIndices) {
                    prepareWorkspaceSwitch.call(this, workspaceIndices);
                    self.#workspaceSwitchConnections =
                        addShadowsInWorkspaceSwitch(this);
                },
        );
        this.#injectionManager.overrideMethod(
            WorkspaceAnimationController.prototype,
            '_finishWorkspaceSwitch',
            finishWorkspaceSwitch =>
                function (switchData) {
                    removeShadowsAfterWorkspaceSwitch(this);
                    finishWorkspaceSwitch.call(this, switchData);
                },
        );

        // Watch for changes of the `enable-preferences-entry` prefs key.
        prefs.connect('changed', (_: Gio.Settings, key: string) => {
            if (key === 'enable-preferences-entry') {
                getPref('enable-preferences-entry')
                    ? enableBackgroundMenuItem()
                    : disableBackgroundMenuItem();
            }
        });



        // Panel indicator
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        const icon = new St.Icon({
            icon_name: INDICATOR_ICON_NAME,
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        const menu = new PopupMenu.PopupMenu(
            this._indicator,   // source actor (the button)
            0.0,               // menu alignment (0 = left-align)
            St.Side.TOP        // arrow side
        );

        // Register the menu with the panel's menu manager so it opens/closes
        // correctly and participates in the global grab/focus handling.
        Main.panel.menuManager.addMenu(menu);

        // Attach the menu to the button so clicking the icon opens it.
        this._indicator.setMenu(menu);

        menu.connect('open-state-changed', (menu: PopupMenu.PopupMenu, isOpen: boolean) => {
            this._menu_opened = isOpen;
            if (isOpen) {
                this._errorLabel?.hide();
                this._vpnSubmenu?.label.set_text("…");
                this._vpnSubmenu?.show();
                this._update_status().catch(e => {
                    logError(e, 'Failed to connect to PADSI service');
                    this._errorLabel?.set_text(e.message);
                    this._errorLabel?.show();
                    this._vpnSubmenu?.hide();
                });
                GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    1,
                    () => {
                        if (! this._menu_opened) return GLib.SOURCE_REMOVE;
                        this._update_status().catch(e => {
                            logError(e, 'Failed to connect to PADSI service');
                            this._errorLabel?.set_text(e.message);
                            this._errorLabel?.show();
                            this._vpnSubmenu?.hide();
                        });
                        return GLib.SOURCE_CONTINUE;
                    }
                );
            }
            return true;
        });

        // Informational label at the top of the menu
        const labelItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,   // not clickable – purely informational
            can_focus: false,
        });
        const vpn_menu = new PopupMenu.PopupSubMenuMenuItem("…");
        menu.addMenuItem(vpn_menu);
        this._vpnSubmenu = vpn_menu;

        const label = new St.Label({
            text: "Error",
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; padding: 2px 0;',
        });
        labelItem.add_child(label);
        menu.addMenuItem(labelItem);
        this._errorLabel = label;

        // Button to launch PADSI's information program
        const buttonItem = new PopupMenu.PopupBaseMenuItem();
        const button = new St.Button({
            label: BUTTON_LABEL,
            style_class: 'button',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => {
            try {
                log(`Starting ${PADSI_UI_PROGRAM}`);
                GLib.spawn_async(null, [PADSI_UI_PROGRAM], null, GLib.SpawnFlags.DEFAULT);
            } catch (error) {
                logError(`Failed to launch "${PADSI_UI_PROGRAM}"`);
                log(`Failed to launch "${PADSI_UI_PROGRAM}"`);
                Main.notifyError(
                    'Extension error',
                    `Could not launch "${PADSI_UI_PROGRAM}": ${error}`
                );
            }
            this._indicator?.menu.close();
        });
        buttonItem.add_child(button);
        menu.addMenuItem(buttonItem);

        // Add the indicator to the right side of the top bar
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        logDebug('Enabled');
    }

    disable() {
        // Restore patched methods
        this.#injectionManager?.clear();
        this.#injectionManager = null;

        // Remove the item to open preferences page in background menu
        disableBackgroundMenuItem();

        this.#windowPicker?.unexport();
        disableEffect();
        clearMutterSettingsCache();

        // Set all props to null
        this.#windowPicker = null;

        if (this.#layoutManagerStartupConnection !== null) {
            try {
                layoutManager.disconnect(this.#layoutManagerStartupConnection);
            } catch (e) { }
            this.#layoutManagerStartupConnection = null;
        }

        for (const connection of this.#workspaceSwitchConnections ?? []) {
            try {
                connection.object.disconnect(connection.id);
            } catch (e) { }
        }

        logDebug('Disabled');

        uninitPrefs();

        this._indicator?.destroy();
        this._indicator = null;
    }


    async _update_status() {
        const rundir = GLib.get_user_runtime_dir();
        const socket = `${rundir}/padsi-userv.sock`;
        if (!GLib.file_test(socket, GLib.FileTest.EXISTS)) {
            throw new Error(`PADSI service is not running`);
        }
        const raw = await requestUnixSocket(socket, '/status');

        const { status, body } = parseHttpResponse(raw);

        if (status !== 200) {
            throw new Error(`Communication error (code ${status})`);
        }

        const data = JSON.parse(body);
        const tsp_data = data.network['traffic-shapers'];
        let nb_tsp = 0;
        let nb_ok = 0;
        this._vpnSubmenu?.menu.removeAll();
        for (const name in tsp_data) {
            const tsp=tsp_data[name];
            nb_tsp += 1;
            if (tsp.functionnal) {
                nb_ok += 1;
                this._vpnSubmenu?.menu.addMenuItem(new PopupMenu.PopupMenuItem(`🟢  ${name}`));
            } else {
                this._vpnSubmenu?.menu.addMenuItem(new PopupMenu.PopupMenuItem(`🔴  ${name}`));
            }
        }

        if (nb_tsp == 0) {
            this._vpnSubmenu?.label.set_text("No VPN configured");
        } else {
            if (nb_tsp == nb_ok) {
                this._vpnSubmenu?.label.set_text(`🟢  VPN connected: ${nb_ok}/${nb_tsp}`);
            }
            else if (nb_ok > 0) {
                this._vpnSubmenu?.label.set_text(`🟠  VPN connected: ${nb_ok}/${nb_tsp}`);
            }
            else {
                this._vpnSubmenu?.label.set_text(`🔴  VPN connected: 0/${nb_tsp}`);
            }
        }
    }
}

function parseHttpResponse(response: string): { status: number; body: string } {
    const [headerPart, body] = response.split('\r\n\r\n');

    const statusLine = headerPart.split('\n')[0];
    const statusMatch = statusLine.match(/HTTP\/1\.1 (\d+)/);

    return {
        status: statusMatch ? parseInt(statusMatch[1], 10) : 0,
        body: body ?? '',
    };
}

async function requestUnixSocket(
    socketPath: string,
    path: string,
    method: string = 'GET',
    body: string | null = null
): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            const client = new Gio.SocketClient();
            const address = new Gio.UnixSocketAddress({
                path: socketPath,
            });

            client.connect_async(address, null, (client, res) => {
                try {
                    const connection = client!.connect_finish(res);
                    const output = connection.get_output_stream();
                    const input = connection.get_input_stream();

                    let request =
                        `${method} ${path} HTTP/1.1\r\n` +
                        `Host: localhost\r\n` +
                        `Connection: close\r\n`;
                    if (body) {
                        request += `Content-Length: ${body.length}\r\n`;
                        request += `Content-Type: application/json\r\n`;
                    }
                    request += `\r\n`;
                    if (body) {
                        request += body;
                    }

                    // Send request
                    output.write_all(
                        new TextEncoder().encode(request),
                        null
                    );

                    // Read response
                    const dataStream = new Gio.DataInputStream({
                        base_stream: input,
                    });
                    let response = '';

                    function readChunk() {
                        dataStream.read_line_async(
                            GLib.PRIORITY_DEFAULT,
                            null,
                            (stream, res) => {
                                try {
                                    const [line] = stream!.read_line_finish(res);
                                    if (line === null) {
                                        resolve(response);
                                        return;
                                    }
                                    response += new TextDecoder().decode(line) + '\n';
                                    readChunk();
                                } catch (e) {
                                    reject(e);
                                }
                            }
                        );
                    }
                    readChunk();
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}
