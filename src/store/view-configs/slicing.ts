import { clampValue } from '@/src/utils';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { useDebounceFn } from '@vueuse/core';
import {
  DoubleKeyRecord,
  deleteSecondKey,
  getDoubleKeyRecord,
  patchDoubleKeyRecord,
} from '@/src/utils/doubleKeyRecord';
import { Maybe } from '@/src/types';
import { useEventBus } from '@/src/composables/useEventBus';
import { useCurrentImage } from '@/src/composables/useCurrentImage';
import { createViewConfigSerializer } from './common';
import { ViewConfig } from '../../io/state-file/schema';
import { SliceConfig } from './types';
import { useWindowingStore } from './windowing';
import { useImageStore } from '../datasets-images';
import { useDICOMStore } from '../datasets-dicom';
import { useLoadDataStore } from '../load-data';

export const defaultSliceConfig = (): SliceConfig => ({
  slice: 0,
  min: 0,
  max: 1,
  axisDirection: 'Inferior',
  syncState: false,
});

export const useViewSliceStore = defineStore('viewSlice', () => {
  const { emitter } = useEventBus();
  const syncWindowLevelWithTag = ref(true);

  const loadDataStore = useLoadDataStore();
  const dicomStore = useDICOMStore();
  const windowingStore = useWindowingStore();

  const handleConfigUpdate = useDebounceFn((viewID, dataID, config) => {
    const volumeKeyUID = loadDataStore.imageIDToVolumeKeyUID[dataID];
    const { layoutName } = loadDataStore.getLoadedByBus(volumeKeyUID);
    if (layoutName && layoutName.includes(viewID) || volumeKeyUID && useImageStore().getPrimaryViewID(dataID) === viewID) {
      if (syncWindowLevelWithTag.value) {
        const volumeSlicesInfo = dicomStore.volumeSlicesInfo[dataID];
        if (volumeSlicesInfo && volumeSlicesInfo.windowingDiffs) {
          const tag = volumeSlicesInfo.tags?.[config.slice];
          const dataRange = volumeSlicesInfo.dataRanges?.[config.slice];
          if (tag && dataRange) {
            const { WindowLevel, WindowWidth } = tag;
            const { min, max } = dataRange;
            try {
              // console.warn(`auto reset windowing based on dicom tags for slice ${config.slice + 1}`);
              windowingStore.updateConfig(viewID, dataID, {
                width: Number(WindowWidth),
                level: Number(WindowLevel),
                min,
                max,
              });
            } catch (error) {
              console.warn(error);
            }
          }
        }
      }
      if (volumeKeyUID) {
        emitter.emit('slicing', {
          uid: volumeKeyUID,
          slice: config.slice,
        });
      }
    }
  }, 1);

  const imageStore = useImageStore();
  const configs = reactive<DoubleKeyRecord<SliceConfig>>({});

  const getConfig = (viewID: Maybe<string>, dataID: Maybe<string>) =>
    getDoubleKeyRecord(configs, viewID, dataID);

  const updateConfig = (
    viewID: string,
    dataID: string,
    patch: Partial<SliceConfig>
  ) => {
    const config = {
      ...defaultSliceConfig(),
      ...getConfig(viewID, dataID),
      ...patch,
    };

    config.slice = clampValue(config.slice, config.min, config.max);
    patchDoubleKeyRecord(configs, viewID, dataID, config);
    handleConfigUpdate(viewID, dataID, config);
  };

  const resetSlice = (viewID: string, dataID: string) => {
    const config = getConfig(viewID, dataID);
    if (!config) return;

    // Setting this to floor() will affect images where the
    // middle slice is fractional.
    // This is consistent with vtkImageMapper and SliceRepresentationProxy.
    updateConfig(viewID, dataID, {
      slice: Math.ceil((config.min + config.max) / 2),
    });
  };

  const removeView = (viewID: string) => {
    delete configs[viewID];
  };

  const removeData = (dataID: string, viewID?: string) => {
    if (viewID) {
      delete configs[viewID]?.[dataID];
    } else {
      deleteSecondKey(configs, dataID);
    }
  };

  const toggleSyncImages = () => {
    // Synchronize all images when toggled
    Object.keys(configs).forEach((viewID) => {
      imageStore.idList.forEach((imageID) => {
        const { syncState } = {
          ...defaultSliceConfig(),
          ...getConfig(viewID, imageID),
        };
        updateConfig(viewID, imageID, { syncState: !syncState });
      });
    });
  };

  const isSync = () => {
    const allSync = Object.keys(configs).every((sc) =>
      Object.keys(configs[sc]).every((c) => configs[sc][c].syncState)
    );

    return allSync;
  };

  const updateSyncConfigs = () => {
    Object.keys(configs).forEach((viewID) => {
      const { currentImageID } = useCurrentImage();
      const config = getConfig(viewID, currentImageID.value);
      imageStore.idList.forEach((imageID) => {
        const { syncState } = {
          ...defaultSliceConfig(),
          ...getConfig(viewID, imageID),
        };

        if (syncState) {
          updateConfig(viewID, imageID, { slice: config?.slice });
        }
      });
    });
  };

  const serialize = createViewConfigSerializer(configs, 'slice');

  const deserialize = (viewID: string, config: Record<string, ViewConfig>) => {
    Object.entries(config).forEach(([dataID, viewConfig]) => {
      if (viewConfig.slice) {
        updateConfig(viewID, dataID, viewConfig.slice);
      }
    });
  };

  return {
    configs,
    getConfig,
    updateConfig,
    resetSlice,
    removeView,
    removeData,
    toggleSyncImages,
    updateSyncConfigs,
    isSync,
    serialize,
    deserialize,
  };
});

export default useViewSliceStore;
