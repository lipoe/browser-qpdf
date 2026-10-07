/**
 * Expected results of encryption-scenarios.mjs, shared by Node and browser tests.
 *
 * Every behavior change of the encryption handling must show up as a diff in
 * this table.
 */

const OK = 'ok';
const INVALID_PASSWORD = { error: 'input.pdf: invalid password' };
const NO_RANDOM_4 = { error: 'unable to read 4 bytes from random number device' };
const NO_RANDOM_16 = { error: 'unable to read 16 bytes from random number device' };

/** Opened document whose writePdf() works and keeps the encryption. */
const OPENED_ENCRYPTION_PRESERVED = {
    imagesMatchSource: true,
    writePdf: OK,
    writtenEncrypted: true,
    writtenReloadWithoutPassword: INVALID_PASSWORD,
    writtenReloadWithUserPassword: OK,
    writtenImagesPreserved: true,
    replaceImageStream: OK,
    writePdfAfterReplace: OK,
    replacedEncrypted: true,
    replacedReloadWithoutPassword: INVALID_PASSWORD,
    replacedReloadWithUserPassword: OK,
    replacedImagesPreserved: true,
};

/** Known bug (v0.1.0): AES output needs random IVs, the WASM build has no random source. */
const OPENED_AES_WRITE_FAILS = {
    imagesMatchSource: true,
    writePdf: NO_RANDOM_16,
    replaceImageStream: OK,
    writePdfAfterReplace: NO_RANDOM_16,
};

const USER_PASSWORD_PROTECTED = {
    loadPdf: INVALID_PASSWORD,
    wrongPassword: INVALID_PASSWORD,
    emptyPassword: INVALID_PASSWORD,
    userPassword: OK,
    ownerPassword: OK,
};

export const EXPECTED_OBSERVATIONS = {
    // Control case: unencrypted source, passwords are ignored
    'multi-image.pdf': {
        loadPdf: OK,
        wrongPassword: OK,
        emptyPassword: OK,
        userPassword: OK,
        ownerPassword: OK,
        opened: {
            imagesMatchSource: true,
            writePdf: OK,
            writtenEncrypted: false,
            writtenReloadWithoutPassword: OK,
            writtenReloadWithUserPassword: OK,
            writtenImagesPreserved: true,
            replaceImageStream: OK,
            writePdfAfterReplace: OK,
            replacedEncrypted: false,
            replacedReloadWithoutPassword: OK,
            replacedReloadWithUserPassword: OK,
            replacedImagesPreserved: true,
        },
    },
    // Known bug (v0.1.0): AES-256 key derivation needs random data
    'aes256-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        userPassword: NO_RANDOM_4,
        ownerPassword: NO_RANDOM_4,
        opened: null,
    },
    'aes128-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        opened: OPENED_AES_WRITE_FAILS,
    },
    'rc4-128-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        opened: OPENED_ENCRYPTION_PRESERVED,
    },
    'rc4-40-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        opened: OPENED_ENCRYPTION_PRESERVED,
    },
    // Known bug (v0.1.0): AES-256 key derivation needs random data
    'aes256-owner-only.pdf': {
        loadPdf: NO_RANDOM_4,
        wrongPassword: INVALID_PASSWORD,
        emptyPassword: NO_RANDOM_4,
        userPassword: NO_RANDOM_4,
        ownerPassword: NO_RANDOM_4,
        opened: null,
    },
    'aes128-owner-only.pdf': {
        loadPdf: OK,
        wrongPassword: INVALID_PASSWORD,
        emptyPassword: OK,
        userPassword: OK,
        ownerPassword: OK,
        opened: OPENED_AES_WRITE_FAILS,
    },
};
