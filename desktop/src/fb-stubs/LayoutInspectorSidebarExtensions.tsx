/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

import {PluginClient, Client, ElementID} from 'flipper';
import {Logger} from 'src/fb-interfaces/Logger';

export default [] as Array<
  (
    client: PluginClient,
    realClient: Client,
    selectedNode: ElementID,
    logger: Logger,
  ) => React.ReactNode
>;
