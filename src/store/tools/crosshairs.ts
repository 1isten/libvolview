import { useCurrentImage } from '@/src/composables/useCurrentImage';
import vtkCrosshairsWidget from '@/src/vtk/CrosshairsWidget';
import { Bounds, Vector3 } from '@kitware/vtk.js/types';
import { computed, ref, unref, watch } from '@vue/composition-api';
import { vec3 } from 'gl-matrix';
import { defineStore } from 'pinia';
import { useView2DConfigStore } from '../view-2D-configs';
import { useView2DStore } from '../views-2D';

export const useCrosshairsToolStore = defineStore('crosshairs', () => {
  type _This = ReturnType<typeof useCrosshairsToolStore>;

  const factory = vtkCrosshairsWidget.newInstance();
  const widgetState = factory.getWidgetState();
  const handle = widgetState.getHandle();

  const active = ref(false);
  const { currentImageID, currentImageMetadata } = useCurrentImage();

  // world-space
  const position = ref<Vector3>([0, 0, 0]);
  // image space
  const imagePosition = computed(() => {
    const out = vec3.create();
    vec3.transformMat4(
      out,
      position.value,
      currentImageMetadata.value.worldToIndex
    );
    return out as Vector3;
  });

  const view2DConfigStore = useView2DConfigStore();
  const view2DStore = useView2DStore();

  const currentViewIDs = computed(() => {
    const imageID = unref(currentImageID);
    if (imageID) {
      return view2DStore.allViewIDs.filter(
        (viewID) => !!view2DConfigStore.getSliceConfig(viewID, imageID)
      );
    }
    return [];
  });

  function getWidgetFactory(this: _This) {
    return factory;
  }

  function setPosition(pos: Vector3) {
    position.value = pos;
  }

  // update the slicing
  watch(imagePosition, (indexPos) => {
    if (active.value) {
      const imageID = unref(currentImageID);
      const { lpsOrientation } = unref(currentImageMetadata);

      if (!imageID) {
        return;
      }

      currentViewIDs.value.forEach((viewID) => {
        const { axis } = view2DStore.orientationConfigs[viewID];
        const index = lpsOrientation[axis];
        const slice = Math.round(indexPos[index]);
        view2DConfigStore.setSlice(viewID, imageID, slice);
      });
    }
  });

  // update widget state based on current image
  watch(
    currentImageMetadata,
    (metadata) => {
      widgetState.setIndexToWorld(metadata.indexToWorld);
      widgetState.setWorldToIndex(metadata.worldToIndex);
      const [xDim, yDim, zDim] = metadata.dimensions;
      const imageBounds: Bounds = [0, xDim - 1, 0, yDim - 1, 0, zDim - 1];
      handle.setBounds(imageBounds);
    },
    { immediate: true }
  );

  // update the position
  handle.onModified(() => {
    const origin = handle.getOrigin();
    if (origin) {
      position.value = origin;
    }
  });

  function setup() {
    widgetState.setPlaced(false);
    active.value = true;
    return true;
  }

  function teardown() {
    active.value = false;
  }

  return {
    getWidgetFactory,
    setPosition,
    position,
    setup,
    teardown,
  };
});