import vtkITKHelper from '@kitware/vtk.js/Common/DataModel/ITKHelper';
import { defineStore } from 'pinia';
import { Image } from 'itk-wasm';
import { DataSourceWithFile } from '@/src/io/import/dataSource';
import * as DICOM from '@/src/io/dicom';
import { identity, pick, removeFromArray } from '../utils';
import { useImageStore } from './datasets-images';
import { useFileStore } from './datasets-files';
import { useLoadDataStore } from './load-data';
import { useViewStore } from './views';
import { StateFile, DatasetType } from '../io/state-file/schema';
import { serializeData } from '../io/state-file/utils';
import { useMessageStore } from './messages';

export const ANONYMOUS_PATIENT = 'Anonymous';
export const ANONYMOUS_PATIENT_ID = 'ANONYMOUS';

export function imageCacheMultiKey(offset: number, asThumbnail: boolean) {
  return `${offset}!!${asThumbnail}`;
}

export interface VolumeKeys {
  patientKey: string;
  studyKey: string;
  volumeKey: string;
}

export interface PatientInfo {
  PatientID: string;
  PatientName: string;
  PatientBirthDate: string;
  PatientSex: string;
  PatientAge?: string;
  PatientWeight?: string;
  PatientAddress?: string;
}

export interface StudyInfo {
  StudyID: string;
  StudyInstanceUID: string;
  StudyDescription: string;
  StudyName?: string;
  StudyDate: string;
  StudyTime: string;
  AccessionNumber: string;
  InstitutionName?: string;
  ReferringPhysicianName?: string;
  ManufacturerModelName?: string;
}

export interface WindowingInfo {
  WindowLevel: string;
  WindowWidth: string;
}

export interface VolumeInfo extends WindowingInfo {
  SeriesInstanceUID: string;
  SeriesNumber: string;
  SeriesDescription: string;
  SeriesDate?: string;
  SeriesTime?: string;
  Modality: string;
  BodyPartExamined?: string;
  RepetitionTime?: string;
  EchoTime?: string;
  MagneticFieldStrength?: string;
  TransferSyntaxUID?: string;

  PixelSpacing?: string;
  Rows?: number | string;
  Columns?: number | string;
  SliceThickness?: string;
  SliceLocation?: string;
  ImagePositionPatient?: string;
  ImageOrientationPatient?: string;

  NumberOfSlices: number;
  VolumeID: string;
}

const buildImage = async (seriesFiles: File[], modality: string) => {
  const messages: string[] = [];
  if (modality === 'SEG') {
    const segFile = seriesFiles[0];
    const results = await DICOM.buildSegmentGroups(segFile);
    if (seriesFiles.length > 1)
      messages.push(
        'Tried to make one volume from 2 SEG modality files. Using only the first file!'
      );
    return {
      modality: 'SEG',
      builtImageResults: results,
      messages,
    };
  }
  return {
    builtImageResults: await DICOM.buildImage(seriesFiles),
    messages,
  };
};

const constructImage = async (volumeKey: string, volumeInfo: VolumeInfo) => {
  const fileStore = useFileStore();
  const files = fileStore.getFiles(volumeKey);
  if (!files) throw new Error('No files for volume key');
  const results = await buildImage(files, volumeInfo.Modality);
  const image = vtkITKHelper.convertItkToVtkImage(
    results.builtImageResults.outputImage
  );
  return {
    ...results,
    image,
  };
};

interface State {
  // volumeKey -> imageCacheMultiKey -> ITKImage
  sliceData: Record<string, Record<string, Image>>;

  // volume invalidation information
  needsRebuild: Record<string, boolean>;

  // Avoid recomputing image data for the same volume by checking this for existing buildVolume tasks
  volumeBuildResults: Record<string, ReturnType<typeof constructImage>>;

  // patientKey -> patient info
  patientInfo: Record<string, PatientInfo>;
  // patientKey -> array of studyKeys
  patientStudies: Record<string, string[]>;

  // studyKey -> study info
  studyInfo: Record<string, StudyInfo>;
  // studyKey -> array of volumeKeys
  studyVolumes: Record<string, string[]>;

  // volumeKey -> volume info
  volumeInfo: Record<string, VolumeInfo>;

  // volumeKey -> volume slices info
  volumeSlicesInfo: Record<string, any>;

  // parent pointers
  // volumeKey -> studyKey
  volumeStudy: Record<string, string>;
  // studyKey -> patientKey
  studyPatient: Record<string, string>;
}

const instanceTags = [
  { name: 'WindowLevel', tag: '0028|1050' }, // WindowCenter
  { name: 'WindowWidth', tag: '0028|1051' },
  // { name: 'SopInstanceUID', tag: '0008|0018' },
  // { name: 'InstanceNumber', tag: '0020|0013' },
  // { name: 'PixelSpacing', tag: '0028|0030' },
  // { name: 'Rows', tag: '0028|0010' },
  // { name: 'Columns', tag: '0028|0011' },
  // { name: 'SliceThickness', tag: '0018|0050' },
  // { name: 'SliceLocation', tag: '0020|1041' },
  // { name: 'ImagePositionPatient', tag: '0020|0032' },
  // { name: 'ImageOrientationPatient', tag: '0020|0037' },
];

const mainDicomTags = [
  // Patient
  { name: 'PatientName', tag: '0010|0010', strconv: true },
  { name: 'PatientID', tag: '0010|0020', strconv: true },
  { name: 'PatientBirthDate', tag: '0010|0030' },
  { name: 'PatientSex', tag: '0010|0040' },
  // { name: 'PatientAge', tag: '0010|1010' },
  // { name: 'PatientWeight', tag: '0010|1030' },
  // { name: 'PatientAddress', tag: '0010|1040' },

  // Study
  { name: 'StudyID', tag: '0020|0010', strconv: true },
  { name: 'StudyInstanceUID', tag: '0020|000d' },
  { name: 'StudyDescription', tag: '0008|1030', strconv: true },
  // { name: 'StudyName', tag: '0010|0010' }, // PatientName
  { name: 'StudyDate', tag: '0008|0020' },
  { name: 'StudyTime', tag: '0008|0030' },
  { name: 'AccessionNumber', tag: '0008|0050' },
  // { name: 'InstitutionName', tag: '0008|0080' },
  // { name: 'ReferringPhysicianName', tag: '0008|0090' },
  // { name: 'ManufacturerModelName', tag: '0008|1090' },

  // Series
  { name: 'SeriesInstanceUID', tag: '0020|000e' },
  { name: 'SeriesNumber', tag: '0020|0011' },
  { name: 'SeriesDescription', tag: '0008|103e', strconv: true },
  // { name: 'SeriesDate', tag: '0008|0021' },
  // { name: 'SeriesTime', tag: '0008|0031' },
  { name: 'Modality', tag: '0008|0060' },
  // { name: 'BodyPartExamined', tag: '0018|0015' },
  // { name: 'RepetitionTime', tag: '0018|0080' },
  // { name: 'EchoTime', tag: '0018|0081' },
  // { name: 'MagneticFieldStrength', tag: '0018|0087' },
  // { name: 'TransferSyntaxUID', tag: '0002|0010' },

  // Instance
  ...instanceTags,
];

export const readDicomTags = (file: File, tags = mainDicomTags) => DICOM.readTags(file, tags);

/**
 * Trims and collapses multiple spaces into one.
 * @param name
 * @returns string
 */
const cleanupName = (name: string) => {
  return name.trim().replace(/\s+/g, ' ');
};

export const getDisplayName = (info: VolumeInfo) => {
  return (
    cleanupName(info.SeriesDescription || info.SeriesNumber) ||
    info.SeriesInstanceUID
  );
};

export const getWindowLevels = (info: VolumeInfo | WindowingInfo) => {
  const { WindowWidth, WindowLevel } = info;
  if (
    WindowWidth == null ||
    WindowLevel == null ||
    WindowWidth === '' ||
    WindowLevel === ''
  )
    return []; // missing tag
  const widths = WindowWidth.split('\\').map(parseFloat);
  const levels = WindowLevel.split('\\').map(parseFloat);
  if (
    widths.some((w) => Number.isNaN(w)) ||
    levels.some((l) => Number.isNaN(l))
  ) {
    console.error('Invalid WindowWidth or WindowLevel DICOM tags');
    return [];
  }
  if (widths.length !== levels.length) {
    console.error(
      'Different numbers of WindowWidth and WindowLevel DICOM tags'
    );
    return [];
  }
  return widths.map((width, i) => ({ width, level: levels[i] }));
};

export const useDICOMStore = defineStore('dicom', {
  state: (): State => ({
    sliceData: {},
    volumeBuildResults: {},
    patientInfo: {},
    patientStudies: {},
    studyInfo: {},
    studyVolumes: {},
    volumeInfo: {},
    volumeSlicesInfo: {},
    volumeStudy: {},
    studyPatient: {},
    needsRebuild: {},
  }),
  actions: {
    volumeKeyGetSuffix: DICOM.volumeKeyGetSuffix,
    readDicomTags,

    async importFiles(datasets: DataSourceWithFile[], volumeKeySuffix?: string) {
      if (!datasets.length) return [];

      const fileToDataSource = new Map(
        datasets.map((ds) => [ds.fileSrc.file, ds])
      );
      const allFiles = [...fileToDataSource.keys()];

      const volumeToFiles = await DICOM.splitAndSort(allFiles, identity, volumeKeySuffix);
      if (Object.keys(volumeToFiles).length === 0) {
        throw new Error('No volumes categorized from DICOM file(s)');
      } else {
        /*
        const volumeKeys = Object.keys(volumeToFiles);
        for (let i = 0; i < volumeKeys.length; i++) {
          const volumeKey = volumeKeys[i];
          // eslint-disable-next-line no-await-in-loop
          const filesWithTagsInfo = await Promise.all(
            volumeToFiles[volumeKey].map(async file => {
              const tags = await this.readDicomTags(file, [
                ...instanceTags,
              ]);
              const windowLevels = getWindowLevels({
                WindowLevel: tags.WindowLevel,
                WindowWidth: tags.WindowWidth,
              });
              return {
                file,
                tags: {
                  ...tags,
                  InstanceNumber: `${parseInt(tags.InstanceNumber || '0', 10)}`,
                  WindowLevel: `${windowLevels[0]?.level || tags.WindowLevel}`,
                  WindowWidth: `${windowLevels[0]?.width || tags.WindowWidth}`,
                },
              };
            })
          );
          filesWithTagsInfo.sort((a, b) => +a.tags.InstanceNumber - +b.tags.InstanceNumber);
          let reSorted = false;
          let windowingDiffs= false;
          const windowLevels: number[] = [];
          const windowWidths: number[] = [];
          const tags: Record<string, string>[] = [];
          volumeToFiles[volumeKey].forEach((file, idx) => {
            const { file: fileSorted, tags: fileTags } = filesWithTagsInfo[idx];
            if (file !== fileSorted) {
              volumeToFiles[volumeKey][idx] = fileSorted;
              reSorted = true;
            }
            tags[idx] = fileTags;
            windowLevels.push(Number(fileTags.WindowLevel));
            windowWidths.push(Number(fileTags.WindowWidth));
          });
          if (
            Math.max(...windowLevels) !== Math.min(...windowLevels) ||
            Math.max(...windowWidths) !== Math.min(...windowWidths)
          ) {
            windowingDiffs = true;
          }
          this.volumeSlicesInfo[volumeKey] = {
            reSorted,
            tags,
            windowingDiffs,
            dataRanges: [],
          };
        }
        */
      }

      const fileStore = useFileStore();

      // Link VolumeKey and DatasetFiles in fileStore
      Object.entries(volumeToFiles).forEach(([volumeKey, files]) => {
        const volumeDatasetFiles = files.map((file) => {
          const source = fileToDataSource.get(file);
          if (!source)
            throw new Error('Did not match File with source DataSource');
          return source;
        });
        fileStore.add(volumeKey, volumeDatasetFiles);
      });

      await Promise.all(
        Object.entries(volumeToFiles).map(async ([volumeKey, files]) => {
          // Read tags of first file
          if (!(volumeKey in this.volumeInfo)) {
            const rawTags = await readDicomTags(files[0]);
            // trim whitespace from all values
            const tags = Object.fromEntries(
              Object.entries(rawTags).map(([key, value]) => [key, value.trim()])
            );
            // TODO parse the raw string values
            const patient = {
              PatientID: tags.PatientID || ANONYMOUS_PATIENT_ID,
              PatientName: tags.PatientName || ANONYMOUS_PATIENT,
              PatientBirthDate: tags.PatientBirthDate || '',
              PatientSex: tags.PatientSex || '',
            };

            const study = pick(
              tags,
              'StudyID',
              'StudyInstanceUID',
              'StudyDate',
              'StudyTime',
              'AccessionNumber',
              'StudyDescription'
            );

            const volumeInfo = {
              ...pick(
                tags,
                'Modality',
                'SeriesInstanceUID',
                'SeriesNumber',
                'SeriesDescription',
                'WindowLevel',
                'WindowWidth'
              ),
              NumberOfSlices: files.length,
              VolumeID: volumeKey,
            };

            this._updateDatabase(patient, study, volumeInfo);
          }

          // invalidate any existing volume
          if (volumeKey in useImageStore().dataIndex) {
            // buildVolume requestor uses this as a rebuild hint
            this.needsRebuild[volumeKey] = true;
          }
        })
      );

      return Object.keys(volumeToFiles);
    },

    _updateDatabase(
      patient: PatientInfo,
      study: StudyInfo,
      volume: VolumeInfo
    ) {
      const patientKey = patient.PatientID;
      const studyKey = study.StudyInstanceUID;
      const volumeKey = volume.VolumeID;

      if (!(patientKey in this.patientInfo)) {
        this.patientInfo[patientKey] = patient;
        this.patientStudies[patientKey] = [];
      }

      if (!(studyKey in this.studyInfo)) {
        this.studyInfo[studyKey] = study;
        this.studyVolumes[studyKey] = [];
        this.studyPatient[studyKey] = patientKey;
        this.patientStudies[patientKey].push(studyKey);
      }

      if (!(volumeKey in this.volumeInfo)) {
        this.volumeInfo[volumeKey] = volume;
        this.volumeStudy[volumeKey] = studyKey;
        this.sliceData[volumeKey] = {};
        this.studyVolumes[studyKey].push(volumeKey);
      }
    },

    // You should probably call datasetStore.remove instead as this does not
    // remove files/images/layers associated with the volume
    deleteVolume(volumeKey: string) {
      if (volumeKey in this.volumeInfo) {
        const studyKey = this.volumeStudy[volumeKey];
        delete this.volumeInfo[volumeKey];
        delete this.sliceData[volumeKey];
        delete this.volumeStudy[volumeKey];

        if (volumeKey in this.volumeBuildResults) {
          delete this.volumeBuildResults[volumeKey];
        }

        removeFromArray(this.studyVolumes[studyKey], volumeKey);
        if (this.studyVolumes[studyKey].length === 0) {
          this._deleteStudy(studyKey);
        }
      }
    },

    _deleteStudy(studyKey: string) {
      if (studyKey in this.studyInfo) {
        const patientKey = this.studyPatient[studyKey];
        delete this.studyInfo[studyKey];
        delete this.studyPatient[studyKey];

        [...this.studyVolumes[studyKey]].forEach((volumeKey) =>
          this.deleteVolume(volumeKey)
        );
        delete this.studyVolumes[studyKey];

        removeFromArray(this.patientStudies[patientKey], studyKey);
        if (this.patientStudies[patientKey].length === 0) {
          this._deletePatient(patientKey);
        }
      }
    },

    _deletePatient(patientKey: string) {
      if (patientKey in this.patientInfo) {
        delete this.patientInfo[patientKey];

        [...this.patientStudies[patientKey]].forEach((studyKey) =>
          this._deleteStudy(studyKey)
        );
        delete this.patientStudies[patientKey];
      }
    },

    async serialize(stateFile: StateFile) {
      const dataIDs = Object.keys(this.volumeInfo);
      await serializeData(stateFile, dataIDs, DatasetType.DICOM);
    },

    async deserialize(files: DataSourceWithFile[], volumeKeySuffix?: string) {
      return this.importFiles(files, volumeKeySuffix).then((volumeKeys) => {
        if (volumeKeys.length !== 1) {
          // Volumes are store individually so we should get one back.
          throw new Error('Invalid state file.');
        }

        return volumeKeys[0];
      });
    },

    // returns an ITK image object
    async getVolumeSlice(
      volumeKey: string,
      sliceIndex: number,
      asThumbnail = false
    ) {
      const fileStore = useFileStore();

      const cacheKey = imageCacheMultiKey(sliceIndex, asThumbnail);
      if (
        volumeKey in this.sliceData &&
        cacheKey in this.sliceData[volumeKey]
      ) {
        return this.sliceData[volumeKey][cacheKey];
      }

      if (!(volumeKey in this.volumeInfo)) {
        throw new Error(`Cannot find given volume key: ${volumeKey}`);
      }
      const volumeInfo = this.volumeInfo[volumeKey];
      const numSlices = volumeInfo.NumberOfSlices;

      if (sliceIndex < 1 || sliceIndex > numSlices) {
        throw new Error(`Slice ${sliceIndex} is out of bounds`);
      }

      const volumeFiles = fileStore.getFiles(volumeKey);

      if (!volumeFiles) {
        throw new Error(`No files found for volume key: ${volumeKey}`);
      }

      const sliceFile = volumeFiles[sliceIndex - 1];

      const itkImage = await DICOM.readVolumeSlice(sliceFile, asThumbnail);

      this.sliceData[volumeKey][cacheKey] = itkImage;
      return itkImage;
    },

    // returns an ITK image object
    async getVolumeThumbnail(volumeKey: string) {
      const { NumberOfSlices } = this.volumeInfo[volumeKey];
      const middleSlice = Math.ceil(NumberOfSlices / 2);
      return this.getVolumeSlice(volumeKey, middleSlice, true);
    },

    async buildVolume(volumeKey: string, forceRebuild: boolean = false) {
      const imageStore = useImageStore();

      const alreadyBuilt = volumeKey in this.volumeBuildResults;
      const buildNeeded =
        forceRebuild || this.needsRebuild[volumeKey] || !alreadyBuilt;
      delete this.needsRebuild[volumeKey];

      // wait for old buildVolume call so we can run imageStore update side effects after
      const oldImagePromise = alreadyBuilt
        ? [this.volumeBuildResults[volumeKey]]
        : [];
      // actually build volume or wait for existing build?
      const newVolumeBuildResults = buildNeeded
        ? constructImage(volumeKey, this.volumeInfo[volumeKey])
        : this.volumeBuildResults[volumeKey];
      // let other calls to buildVolume reuse this constructImage work
      this.volumeBuildResults[volumeKey] = newVolumeBuildResults;
      const [volumeBuildResults] = await Promise.all([
        newVolumeBuildResults,
        ...oldImagePromise,
      ]);

      // update image store
      const imageExists = imageStore.dataIndex[volumeKey];
      if (imageExists) {
        // was a rebuild
        imageStore.updateData(volumeKey, volumeBuildResults.image);
      } else {
        const info = this.volumeInfo[volumeKey];
        const name = getDisplayName(info);
        imageStore.addVTKImageData(name, volumeBuildResults.image, volumeKey);

        // auto set layout to be the correct axis view (when loaded by bus)
        const loadDataStore = useLoadDataStore();
        const viewStore = useViewStore();
        const viewID = imageStore.getPrimaryViewID(volumeKey);
        const volumeKeySuffix = this.volumeKeyGetSuffix(volumeKey);
        if (volumeKeySuffix) {
          if (viewID) {
            const { layoutName, defaultSlices, slice } = loadDataStore.getLoadedByBus(volumeKeySuffix);
            if (layoutName === undefined) {
              loadDataStore.setLoadedByBus(volumeKeySuffix, {
                layoutName: viewStore.getLayoutByViewID(viewID),
              });
            }
            if (slice !== undefined && (defaultSlices === undefined || defaultSlices[viewID] === undefined)) {
              loadDataStore.setLoadedByBus(volumeKeySuffix, {
                defaultSlices: {
                  ...(defaultSlices || {}),
                  [viewID]: slice,
                },
              });
            }
          }
        } else if (viewID) {
          // viewStore.setLayoutByViewID(viewID);
        }
      }

      const messageStore = useMessageStore();
      volumeBuildResults.messages.forEach((message) => {
        console.warn(message);
        messageStore.addWarning(message);
      });

      return volumeBuildResults;
    },
  },
});
