/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {FlipperPlugin, FlipperDevicePlugin} from './plugin';
import BaseDevice, {OS} from './devices/BaseDevice';
import {App} from './App.js';
import {Logger} from './fb-interfaces/Logger';
import {Store} from './reducers/index';
import {setPluginState} from './reducers/pluginStates';
import {Payload, ConnectionStatus} from 'rsocket-types';
import {Flowable, Single} from 'rsocket-flowable';
import {performance} from 'perf_hooks';
import {reportPlatformFailures, reportPluginFailures} from './utils/metrics';
import {notNull} from './utils/typeUtils';
import {default as isProduction} from './utils/isProduction';
import {registerPlugins} from './reducers/plugins';
import createTableNativePlugin from './plugins/TableNativePlugin';
import EventEmitter from 'events';
import invariant from 'invariant';
import {flipperRecorderAddEvent} from './utils/pluginStateRecorder';
import {getPluginKey} from './utils/pluginUtils';
import {
  processMessageImmediately,
  processMessageLater,
} from './utils/messageQueue';
import GK from './fb-stubs/GK';

type Plugins = Array<string>;

export type ClientQuery = {
  app: string;
  os: OS;
  device: string;
  device_id: string;
  sdk_version?: number;
};

export type ClientExport = {
  id: string;
  query: ClientQuery;
};

type ErrorType = {message: string; stacktrace: string; name: string};
type Params = {
  api: string;
  method: string;
  params?: Object;
};
type RequestMetadata = {method: string; id: number; params: Params | undefined};

const handleError = (store: Store, device: BaseDevice, error: ErrorType) => {
  if (isProduction()) {
    return;
  }
  const crashReporterPlugin = store
    .getState()
    .plugins.devicePlugins.get('CrashReporter');
  if (!crashReporterPlugin) {
    return;
  }

  const pluginKey = getPluginKey(null, device, 'CrashReporter');

  const persistedState = {
    ...crashReporterPlugin.defaultPersistedState,
    ...store.getState().pluginStates[pluginKey],
  };
  const isCrashReport: boolean = Boolean(error.name || error.message);
  const payload = isCrashReport
    ? {
        name: error.name,
        reason: error.message,
        callstack: error.stacktrace,
      }
    : {
        name: 'Plugin Error',
        reason: JSON.stringify(error),
      };

  const newPluginState =
    crashReporterPlugin.persistedStateReducer == null
      ? persistedState
      : crashReporterPlugin.persistedStateReducer(
          persistedState,
          'flipper-crash-report',
          payload,
        );
  if (persistedState !== newPluginState) {
    store.dispatch(
      setPluginState({
        pluginKey,
        state: newPluginState,
      }),
    );
  }
};

export interface FlipperClientConnection<D, M> {
  connectionStatus(): Flowable<ConnectionStatus>;
  close(): void;
  fireAndForget(payload: Payload<D, M>): void;
  requestResponse(payload: Payload<D, M>): Single<Payload<D, M>>;
}

export default class Client extends EventEmitter {
  app: App | undefined;
  connected: boolean;
  id: string;
  query: ClientQuery;
  sdkVersion: number;
  messageIdCounter: number;
  plugins: Plugins;
  connection: FlipperClientConnection<any, any> | null | undefined;
  store: Store;
  activePlugins: Set<string>;
  device: Promise<BaseDevice>;
  _deviceResolve: (device: BaseDevice) => void = _ => {};
  _deviceSet: false | BaseDevice = false;
  logger: Logger;
  lastSeenDeviceList: Array<BaseDevice>;
  broadcastCallbacks: Map<string, Map<string, Set<Function>>>;
  rIC: any;

  requestCallbacks: Map<
    number,
    {
      resolve: (data: any) => void;
      reject: (err: Error) => void;
      metadata: RequestMetadata;
      // eslint-disable-next-line prettier/prettier
    }
  >;

  constructor(
    id: string,
    query: ClientQuery,
    conn: FlipperClientConnection<any, any> | null | undefined,
    logger: Logger,
    store: Store,
    plugins?: Plugins | null | undefined,
    device?: BaseDevice,
  ) {
    super();
    this.connected = true;
    this.plugins = plugins ? plugins : [];
    this.connection = conn;
    this.id = id;
    this.query = query;
    this.sdkVersion = query.sdk_version || 0;
    this.messageIdCounter = 0;
    this.logger = logger;
    this.store = store;
    this.broadcastCallbacks = new Map();
    this.requestCallbacks = new Map();
    this.activePlugins = new Set();
    this.lastSeenDeviceList = [];

    this.device = device
      ? Promise.resolve(device)
      : new Promise((resolve, _reject) => {
          this._deviceResolve = resolve;
        });
    if (device) {
      this._deviceSet = device;
    }

    const client = this;
    // node.js doesn't support requestIdleCallback
    this.rIC =
      typeof window === 'undefined' || !window.requestIdleCallback
        ? (cb: Function, _: any) => {
            cb();
          }
        : window.requestIdleCallback.bind(window);

    if (conn) {
      conn.connectionStatus().subscribe({
        onNext(payload) {
          if (payload.kind == 'ERROR' || payload.kind == 'CLOSED') {
            client.connected = false;
          }
        },
        onSubscribe(subscription) {
          subscription.request(Number.MAX_SAFE_INTEGER);
        },
      });
    }
  }

  /* All clients should have a corresponding Device in the store.
     However, clients can connect before a device is registered, so wait a
     while for the device to be registered if it isn't already. */
  setMatchingDevice(): void {
    if (this._deviceSet) {
      return;
    }
    reportPlatformFailures(
      new Promise<BaseDevice>((resolve, reject) => {
        let unsubscribe: () => void = () => {};

        const device = this.store
          .getState()
          .connections.devices.find(
            device => device.serial === this.query.device_id,
          );
        if (device) {
          resolve(device);
          return;
        }

        const timeout = setTimeout(() => {
          unsubscribe();
          const error = `Timed out waiting for device for client ${this.id}`;
          console.error(error);
          reject(error);
        }, 5000);
        unsubscribe = this.store.subscribe(() => {
          const newDeviceList = this.store.getState().connections.devices;
          if (newDeviceList === this.lastSeenDeviceList) {
            return;
          }
          this.lastSeenDeviceList = this.store.getState().connections.devices;
          const matchingDevice = newDeviceList.find(
            device => device.serial === this.query.device_id,
          );
          if (matchingDevice) {
            clearTimeout(timeout);
            resolve(matchingDevice);
            unsubscribe();
          }
        });
      }),
      'client-setMatchingDevice',
    ).then(device => {
      this._deviceSet = device;
      this._deviceResolve(device);
    });
  }

  supportsPlugin(Plugin: typeof FlipperPlugin): boolean {
    return this.plugins.includes(Plugin.id);
  }

  async init() {
    this.setMatchingDevice();
    await this.getPlugins();
  }

  // get the supported plugins
  async getPlugins(): Promise<Plugins> {
    const plugins = await this.rawCall<{plugins: Plugins}>(
      'getPlugins',
      false,
    ).then(data => data.plugins);
    this.plugins = plugins;
    const nativeplugins = plugins
      .map(plugin => /_nativeplugin_([^_]+)_([^_]+)/.exec(plugin))
      .filter(notNull)
      .map(([id, type, title]) => {
        // TODO put this in another component, and make the "types" registerable
        switch (type) {
          case 'Table':
            return createTableNativePlugin(id, title);
          default: {
            return null;
          }
        }
      })
      .filter(Boolean);
    this.store.dispatch(registerPlugins(nativeplugins as any));
    return plugins;
  }

  // get the plugins, and update the UI
  async refreshPlugins() {
    await this.getPlugins();
    this.emit('plugins-change');
  }

  async deviceSerial(): Promise<string> {
    try {
      const device = await this.device;
      if (!device) {
        console.error('Using "" for deviceId device is not ready');
        return '';
      }
      return device.serial;
    } catch (e) {
      console.error(
        'Using "" for deviceId because client has no matching device',
      );
      return '';
    }
  }

  onMessage(msg: string) {
    if (typeof msg !== 'string') {
      return;
    }

    let rawData;
    try {
      rawData = JSON.parse(msg);
    } catch (err) {
      console.error(`Invalid JSON: ${msg}`, 'clientMessage');
      return;
    }

    const data: {
      id?: number;
      method?: string;
      params?: Params;
      success?: Object;
      error?: ErrorType;
    } = rawData;

    const {id, method} = data;

    if (id == null) {
      const {error} = data;
      if (error != null) {
        console.error(
          `Error received from device ${
            method ? `when calling ${method}` : ''
          }: ${error.message} + \nDevice Stack Trace: ${error.stacktrace}`,
          'deviceError',
        );
        this.device.then(device => handleError(this.store, device, error));
      } else if (method === 'refreshPlugins') {
        this.refreshPlugins();
      } else if (method === 'execute') {
        invariant(data.params, 'expected params');
        const params: Params = data.params;

        const device = this.getDeviceSync();
        if (device) {
          const persistingPlugin:
            | typeof FlipperPlugin
            | typeof FlipperDevicePlugin
            | undefined =
            this.store.getState().plugins.clientPlugins.get(params.api) ||
            this.store.getState().plugins.devicePlugins.get(params.api);

          if (persistingPlugin && persistingPlugin.persistedStateReducer) {
            const pluginKey = getPluginKey(this.id, device, params.api);
            flipperRecorderAddEvent(pluginKey, params.method, params.params);
            if (GK.get('flipper_event_queue')) {
              processMessageLater(
                this.store,
                pluginKey,
                persistingPlugin,
                params,
              );
            } else {
              processMessageImmediately(
                this.store,
                pluginKey,
                persistingPlugin,
                params,
              );
            }
          }
        } else {
          console.warn(
            `Received a message for plugin ${params.api}.${params.method}, which will be ignored because the device has not connected yet`,
          );
        }
        const apiCallbacks = this.broadcastCallbacks.get(params.api);
        if (!apiCallbacks) {
          return;
        }

        const methodCallbacks = apiCallbacks.get(params.method);
        if (methodCallbacks) {
          for (const callback of methodCallbacks) {
            callback(params.params);
          }
        }
      }
      return; // method === 'execute'
    }

    if (this.sdkVersion < 1) {
      const callbacks = this.requestCallbacks.get(id);
      if (!callbacks) {
        return;
      }
      this.requestCallbacks.delete(id);
      this.finishTimingRequestResponse(callbacks.metadata);
      this.onResponse(data, callbacks.resolve, callbacks.reject);
    }
  }

  onResponse(
    data: {
      success?: Object;
      error?: ErrorType;
    },
    resolve: ((a: any) => any) | undefined,
    reject: (error: ErrorType) => any,
  ) {
    if (data.success) {
      resolve && resolve(data.success);
    } else if (data.error) {
      reject(data.error);
      const {error} = data;
      if (error) {
        this.device.then(device => handleError(this.store, device, error));
      }
    } else {
      // ???
    }
  }

  toJSON(): ClientExport {
    return {id: this.id, query: this.query};
  }

  subscribe(api: string, method: string, callback: (params: Object) => void) {
    let apiCallbacks = this.broadcastCallbacks.get(api);
    if (!apiCallbacks) {
      apiCallbacks = new Map();
      this.broadcastCallbacks.set(api, apiCallbacks);
    }

    let methodCallbacks = apiCallbacks.get(method);
    if (!methodCallbacks) {
      methodCallbacks = new Set();
      apiCallbacks.set(method, methodCallbacks);
    }
    methodCallbacks.add(callback);
  }

  unsubscribe(api: string, method: string, callback: Function) {
    const apiCallbacks = this.broadcastCallbacks.get(api);
    if (!apiCallbacks) {
      return;
    }

    const methodCallbacks = apiCallbacks.get(method);
    if (!methodCallbacks) {
      return;
    }
    methodCallbacks.delete(callback);
  }

  rawCall<T>(method: string, fromPlugin: boolean, params?: Params): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.messageIdCounter++;
      const metadata: RequestMetadata = {
        method,
        id,
        params,
      };

      if (this.sdkVersion < 1) {
        this.requestCallbacks.set(id, {reject, resolve, metadata});
      }

      const data = {
        id,
        method,
        params,
      };

      const plugin = params ? params.api : undefined;

      console.debug(data, 'message:call');

      if (this.sdkVersion < 1) {
        this.startTimingRequestResponse({method, id, params});
        if (this.connection) {
          this.connection.fireAndForget({data: JSON.stringify(data)});
        }
        return;
      }

      const mark = this.getPerformanceMark(metadata);
      performance.mark(mark);
      if (!fromPlugin || this.isAcceptingMessagesFromPlugin(plugin)) {
        this.connection &&
          this.connection
            .requestResponse({data: JSON.stringify(data)})
            .subscribe({
              onComplete: payload => {
                if (!fromPlugin || this.isAcceptingMessagesFromPlugin(plugin)) {
                  const logEventName = this.getLogEventName(data);
                  this.logger.trackTimeSince(mark, logEventName);
                  const response: {
                    success?: Object;
                    error?: ErrorType;
                  } = JSON.parse(payload.data);
                  this.onResponse(response, resolve, reject);
                }
              },
              // Open fresco then layout and you get errors because responses come back after deinit.
              onError: e => {
                if (this.isAcceptingMessagesFromPlugin(plugin)) {
                  reject(e);
                }
              },
            });
      }
    });
  }

  getDeviceSync(): BaseDevice | undefined {
    return this._deviceSet || undefined;
  }

  startTimingRequestResponse(data: RequestMetadata) {
    performance.mark(this.getPerformanceMark(data));
  }

  finishTimingRequestResponse(data: RequestMetadata) {
    const mark = this.getPerformanceMark(data);
    const logEventName = this.getLogEventName(data);
    this.logger.trackTimeSince(mark, logEventName);
  }

  isAcceptingMessagesFromPlugin(plugin: string | null | undefined) {
    return this.connection && (!plugin || this.activePlugins.has(plugin));
  }

  getPerformanceMark(data: RequestMetadata): string {
    const {method, id} = data;
    return `request_response_${method}_${id}`;
  }

  getLogEventName(data: RequestMetadata): string {
    const {method, params} = data;
    return params && params.api && params.method
      ? `request_response_${method}_${params.api}_${params.method}`
      : `request_response_${method}`;
  }

  initPlugin(pluginId: string) {
    this.activePlugins.add(pluginId);
    this.rawSend('init', {plugin: pluginId});
  }

  deinitPlugin(pluginId: string) {
    this.activePlugins.delete(pluginId);
    this.rawSend('deinit', {plugin: pluginId});
  }

  rawSend(method: string, params?: Object): void {
    const data = {
      method,
      params,
    };
    console.debug(data, 'message:send');
    if (this.connection) {
      this.connection.fireAndForget({data: JSON.stringify(data)});
    }
  }

  call(
    api: string,
    method: string,
    fromPlugin: boolean,
    params?: Object,
  ): Promise<Object> {
    return reportPluginFailures(
      this.rawCall('execute', fromPlugin, {api, method, params}),
      `Call-${method}`,
      api,
    );
  }

  send(api: string, method: string, params?: Object): void {
    if (!isProduction()) {
      console.warn(
        `${api}:${method ||
          ''} client.send() is deprecated. Please use call() instead so you can handle errors.`,
      );
    }
    return this.rawSend('execute', {api, method, params});
  }

  async supportsMethod(api: string, method: string): Promise<boolean> {
    if (this.sdkVersion < 2) {
      return Promise.resolve(false);
    }
    const response = await this.rawCall<{
      isSupported: boolean;
    }>('isMethodSupported', true, {
      api,
      method,
    });
    return response.isSupported;
  }
}
