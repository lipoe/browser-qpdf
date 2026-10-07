/**
 * Expected results of encryption-scenarios.mjs, shared by Node and browser tests.
 *
 * Every behavior change of the encryption handling must show up as a diff in
 * this table.
 */

const OK = 'ok';
const INVALID_PASSWORD = { error: 'input.pdf: invalid password' };

/** Opened document whose writePdf() keeps the encryption (default). */
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

/** Owner-password-only PDF: output stays encrypted but opens without password. */
const OPENED_OWNER_ONLY_ENCRYPTION_PRESERVED = {
    ...OPENED_ENCRYPTION_PRESERVED,
    writtenReloadWithoutPassword: OK,
    replacedReloadWithoutPassword: OK,
};

const USER_PASSWORD_PROTECTED = {
    loadPdf: INVALID_PASSWORD,
    wrongPassword: INVALID_PASSWORD,
    emptyPassword: INVALID_PASSWORD,
    userPassword: OK,
    ownerPassword: OK,
};

/** No open password: loads without password; a wrong non-empty password is rejected. */
const OWNER_PASSWORD_ONLY = {
    loadPdf: OK,
    wrongPassword: INVALID_PASSWORD,
    emptyPassword: OK,
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
    'aes256-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        opened: OPENED_ENCRYPTION_PRESERVED,
    },
    'aes128-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        opened: OPENED_ENCRYPTION_PRESERVED,
    },
    'rc4-128-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        opened: OPENED_ENCRYPTION_PRESERVED,
    },
    'rc4-40-user.pdf': {
        ...USER_PASSWORD_PROTECTED,
        opened: OPENED_ENCRYPTION_PRESERVED,
    },
    'aes256-owner-only.pdf': {
        ...OWNER_PASSWORD_ONLY,
        opened: OPENED_OWNER_ONLY_ENCRYPTION_PRESERVED,
    },
    'aes128-owner-only.pdf': {
        ...OWNER_PASSWORD_ONLY,
        opened: OPENED_OWNER_ONLY_ENCRYPTION_PRESERVED,
    },
};
