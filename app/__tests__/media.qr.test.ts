/**
 * A photo picked to be *read* and a photo picked to be *sent* are opposite
 * jobs. Sending downscales, because the bytes are encrypted and shipped whole.
 * Reading must not: the picker's convenience resize smears the module edges of
 * a QR until nothing can decode it, and a code that will not decode is an ID
 * that never reaches the person it was meant for. Everything asserted here is
 * that separation holding.
 */

import {
  AVATAR_PHOTO,
  MESSAGE_PHOTO,
  PickCancelled,
  PickDenied,
  PickTooLarge,
  PickUnavailable,
  QR_MAX_BYTES,
  QR_MAX_PIXELS,
  pickImage,
  pickImageFile,
} from '../src/media';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));
const picker = jest.requireMock('react-native-image-picker') as {
  launchImageLibrary: jest.Mock;
  launchCamera: jest.Mock;
};

const URI = 'file:///tmp/picked/IMG_0042.HEIC';

beforeEach(() => {
  picker.launchImageLibrary.mockReset();
  picker.launchCamera.mockReset();
});

describe('pickImageFile options', () => {
  test('asks the picker for the original file — no resize, no re-encode', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: URI, width: 3024, height: 4032, fileSize: 2_400_000 }],
    });
    await pickImageFile('library');
    const opts = picker.launchImageLibrary.mock.calls[0][0];
    // The three that would silently destroy every real decode. This test is
    // here so nobody "helpfully" reuses MESSAGE_PHOTO for the QR path.
    expect(opts).not.toHaveProperty('maxWidth');
    expect(opts).not.toHaveProperty('maxHeight');
    expect(opts).not.toHaveProperty('quality');
    expect(opts.includeBase64).toBe(false);
    expect(opts.assetRepresentationMode).toBe('current');
    expect(opts.mediaType).toBe('photo');
    expect(opts.selectionLimit).toBe(1);
    // fileSize only arrives with includeExtra, so the byte bound below is real.
    expect(opts.includeExtra).toBe(true);
  });

  test('returns where the file is, never what is in it', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [
        {
          uri: URI,
          width: 3024,
          height: 4032,
          fileSize: 2_400_000,
          base64: 'should-be-ignored',
        },
      ],
    });
    const file = await pickImageFile('library');
    expect(file).toEqual({ uri: URI, width: 3024, height: 4032 });
    expect(file).not.toHaveProperty('base64');
  });

  test('the camera variant never writes a copy back to Photos', async () => {
    picker.launchCamera.mockResolvedValue({
      assets: [{ uri: URI, width: 1024, height: 1024 }],
    });
    await pickImageFile('camera');
    expect(picker.launchImageLibrary).not.toHaveBeenCalled();
    expect(picker.launchCamera.mock.calls[0][0].saveToPhotos).toBe(false);
  });
});

describe('pickImageFile refusals', () => {
  test('backing out is PickCancelled, not a failure', async () => {
    picker.launchImageLibrary.mockResolvedValue({ didCancel: true });
    await expect(pickImageFile('library')).rejects.toBeInstanceOf(PickCancelled);
  });

  test('a denial names the source, so the screen can offer Settings', async () => {
    picker.launchImageLibrary.mockResolvedValue({ errorCode: 'permission' });
    await expect(pickImageFile('library')).rejects.toMatchObject({
      source: 'library',
    });
    await expect(pickImageFile('library')).rejects.toBeInstanceOf(PickDenied);
  });

  test('a denial is classified before the missing asset it also causes', async () => {
    // Both conditions arrive together; reporting "photo unreadable" for a
    // permission the person can grant sends them nowhere useful.
    picker.launchImageLibrary.mockResolvedValue({
      errorCode: 'permission',
      assets: [],
    });
    await expect(pickImageFile('library')).rejects.toBeInstanceOf(PickDenied);
  });

  test('no camera is PickUnavailable', async () => {
    picker.launchCamera.mockResolvedValue({ errorCode: 'camera_unavailable' });
    await expect(pickImageFile('camera')).rejects.toBeInstanceOf(
      PickUnavailable,
    );
  });

  test('a missing uri is a plain Error, not one of the actionable classes', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ width: 100, height: 100 }],
    });
    const err = await pickImageFile('library').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PickDenied);
    expect(err).not.toBeInstanceOf(PickTooLarge);
    expect(err).not.toBeInstanceOf(PickCancelled);
  });

  test('missing dimensions are unreadable rather than a zero-pixel decode', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: URI, width: 0, height: 0 }],
    });
    await expect(pickImageFile('library')).rejects.toBeInstanceOf(Error);
  });

  test('too many pixels is refused before anything is allocated', async () => {
    const edge = Math.ceil(Math.sqrt(QR_MAX_PIXELS)) + 1;
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: URI, width: edge, height: edge }],
    });
    await expect(pickImageFile('library')).rejects.toBeInstanceOf(PickTooLarge);
  });

  test('a pixel count exactly at the ceiling is still accepted', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: URI, width: QR_MAX_PIXELS, height: 1 }],
    });
    await expect(pickImageFile('library')).resolves.toMatchObject({ uri: URI });
  });

  test('too many bytes is refused', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [
        { uri: URI, width: 100, height: 100, fileSize: QR_MAX_BYTES + 1 },
      ],
    });
    await expect(pickImageFile('library')).rejects.toBeInstanceOf(PickTooLarge);
  });

  test('an absent fileSize is not a refusal — the native side bounds it again', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ uri: URI, width: 100, height: 100 }],
    });
    await expect(pickImageFile('library')).resolves.toEqual({
      uri: URI,
      width: 100,
      height: 100,
    });
  });
});

describe('the sending path is undisturbed', () => {
  test('a message photo is still downscaled and still arrives as base64', async () => {
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ base64: 'AAAA', width: 1440, height: 1080 }],
    });
    const picked = await pickImage('library', MESSAGE_PHOTO);
    const opts = picker.launchImageLibrary.mock.calls[0][0];
    expect(opts.maxWidth).toBe(1440);
    expect(opts.maxHeight).toBe(1440);
    expect(opts.quality).toBe(0.7);
    expect(opts.includeBase64).toBe(true);
    expect(opts).not.toHaveProperty('assetRepresentationMode');
    expect(picked).toEqual({ base64: 'AAAA', width: 1440, height: 1080 });
  });

  test('an avatar is still downscaled to its own smaller edge', async () => {
    picker.launchCamera.mockResolvedValue({
      assets: [{ base64: 'BBBB', width: 512, height: 512 }],
    });
    const picked = await pickImage('camera', AVATAR_PHOTO);
    const opts = picker.launchCamera.mock.calls[0][0];
    expect(opts.maxWidth).toBe(512);
    expect(opts.maxHeight).toBe(512);
    expect(opts.quality).toBe(0.8);
    expect(opts.includeBase64).toBe(true);
    expect(picked.base64).toBe('BBBB');
  });

  test('the send ceiling still applies to a sent photo and not to a read one', async () => {
    const huge = 'x'.repeat(11 * 1024 * 1024);
    picker.launchImageLibrary.mockResolvedValue({
      assets: [{ base64: huge, width: 10, height: 10 }],
    });
    await expect(pickImage('library', MESSAGE_PHOTO)).rejects.toThrow();
    // Nothing from pickImageFile is ever sent, so MAX_ATTACHMENT_BYTES is not
    // its bound — a 20 MB photo is a perfectly reasonable thing to read a QR
    // out of.
    picker.launchImageLibrary.mockResolvedValue({
      assets: [
        { uri: URI, width: 4032, height: 3024, fileSize: 20 * 1024 * 1024 },
      ],
    });
    await expect(pickImageFile('library')).resolves.toMatchObject({ uri: URI });
  });
});
