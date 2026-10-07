/**
 * Expected results of encryption-scenarios.mjs, shared by Node and browser tests.
 *
 * Every behavior change of the encryption handling must show up as a diff in
 * this table.
 */

const OK = 'ok';
const PASSWORD_MESSAGE = 'input.pdf: invalid password';
/** loadPdf() without password on a PDF that needs one */
const PASSWORD_REQUIRED = { code: 'PASSWORD_REQUIRED', error: PASSWORD_MESSAGE };
/** loadPdfWithPassword() with a password that does not open the PDF */
const INVALID_PASSWORD = { code: 'INVALID_PASSWORD', error: PASSWORD_MESSAGE };

/** Write results that are plain (unencrypted) PDFs with the expected images. */
function plainOutput(prefix) {
    return {
        [`${prefix}Encrypted`]: false,
        [`${prefix}ReloadWithoutPassword`]: OK,
        [`${prefix}ReloadWithUserPassword`]: OK,
        [`${prefix}ImagesPreserved`]: true,
    };
}

/** Write results that keep the source encryption. */
function encryptedOutput(prefix, { opensWithoutPassword }) {
    return {
        [`${prefix}Encrypted`]: true,
        [`${prefix}ReloadWithoutPassword`]: opensWithoutPassword ? OK : PASSWORD_REQUIRED,
        [`${prefix}ReloadWithUserPassword`]: OK,
        [`${prefix}ImagesPreserved`]: true,
    };
}

/**
 * Opened document: writePdf() keeps the encryption by default,
 * writePdf({ preserveEncryption: false }) writes a plain PDF.
 */
function openedDocument({ isEncrypted, opensWithoutPassword }) {
    const defaultOutput = isEncrypted
        ? (prefix) => encryptedOutput(prefix, { opensWithoutPassword })
        : plainOutput;
    return {
        isEncrypted,
        imagesMatchSource: true,
        writePdf: OK,
        ...defaultOutput('written'),
        writePdfDecrypted: OK,
        ...plainOutput('decrypted'),
        replaceImageStream: OK,
        writePdfAfterReplace: OK,
        ...defaultOutput('replaced'),
        writePdfAfterReplaceDecrypted: OK,
        ...plainOutput('replacedDecrypted'),
    };
}

/** PDF with an open (user) password. */
const USER_PASSWORD_PROTECTED = {
    loadPdf: PASSWORD_REQUIRED,
    wrongPassword: INVALID_PASSWORD,
    emptyPassword: INVALID_PASSWORD,
    userPassword: OK,
    ownerPassword: OK,
    opened: openedDocument({ isEncrypted: true, opensWithoutPassword: false }),
};

/** No open password: loads without password; a wrong non-empty password is rejected. */
const OWNER_PASSWORD_ONLY = {
    loadPdf: OK,
    wrongPassword: INVALID_PASSWORD,
    emptyPassword: OK,
    userPassword: OK,
    ownerPassword: OK,
    opened: openedDocument({ isEncrypted: true, opensWithoutPassword: true }),
};

export const EXPECTED_OBSERVATIONS = {
    // Control case: unencrypted source, passwords are ignored
    'multi-image.pdf': {
        loadPdf: OK,
        wrongPassword: OK,
        emptyPassword: OK,
        userPassword: OK,
        ownerPassword: OK,
        opened: openedDocument({ isEncrypted: false }),
    },
    'aes256-user.pdf': USER_PASSWORD_PROTECTED,
    'aes128-user.pdf': USER_PASSWORD_PROTECTED,
    'rc4-128-user.pdf': USER_PASSWORD_PROTECTED,
    'rc4-40-user.pdf': USER_PASSWORD_PROTECTED,
    'aes256-owner-only.pdf': OWNER_PASSWORD_ONLY,
    'aes128-owner-only.pdf': OWNER_PASSWORD_ONLY,
};
