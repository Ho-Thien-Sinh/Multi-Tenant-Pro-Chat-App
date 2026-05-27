import { Response } from 'express';

interface IViolation {
    message: {
        en: string;
        vi: string;
    };
    type: string;
    code: number;
    field?: string;
}

export interface IApiResponse<T = any> {
    message: string;
    message_en: string;
    data: T | null;
    status: 'success' | 'fail' | 'error';
    timeStamp?: string;
    violations?: IViolation[] | undefined;
    limitReached?: boolean | undefined;
    downloadCount?: number | undefined;
    remainingTime?: number | undefined;
}

export const createResponse = <T = any>(
    res: Response,
    status: number,
    options: {
        message: string;
        message_en: string;
        data?: T | null;
        status: 'success' | 'fail' | 'error';
        violations?: IViolation[] | undefined;
        limitReached?: boolean | undefined;
        downloadCount?: number | undefined;
        remainingTime?: number | undefined;
    }
) => {
    const response: IApiResponse<T> = {
        message: options.message,
        message_en: options.message_en,
        data: options.data || null,
        status: options.status,
        timeStamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        violations: options.violations,
        limitReached: options.limitReached,
        downloadCount: options.downloadCount,
        remainingTime: options.remainingTime
    };

    return res.status(status).json(response);
};

export const successResponse = <T>(
    res: Response,
    statusCode: number,
    message: string,
    data?: T | null,
    message_en: string = message
) => {
    return createResponse(res, statusCode, {
        message,
        message_en,
        data,
        status: 'success',
    });
};

export const errorResponse = (
    res: Response,
    statusCode: number,
    message: string,
    message_en: string = message,
    violations?: IViolation[]
) => {
    return createResponse(res, statusCode, {
        message,
        message_en,
        status: 'error',
        violations,
    });
};

// --- New Utility Helpers ---

/**
 * 400 - Bad Request
 */
export const badRequest = (
    res: Response,
    message: string = 'Yêu cầu không hợp lệ',
    message_en: string = 'Bad request',
    violations?: IViolation[]
) => {
    return createResponse(res, 400, {
        message,
        message_en,
        status: 'fail',
        violations
    });
};

/**
 * 401 - Unauthorized
 */
export const unauthorized = (
    res: Response,
    message: string = 'Phiên làm việc hết hạn hoặc không hợp lệ',
    message_en: string = 'Unauthorized'
) => {
    return createResponse(res, 401, {
        message,
        message_en,
        status: 'fail'
    });
};

/**
 * 403 - Forbidden
 */
export const forbidden = (
    res: Response,
    message: string = 'Bạn không có quyền thực hiện hành động này',
    message_en: string = 'Forbidden'
) => {
    return createResponse(res, 403, {
        message,
        message_en,
        status: 'fail'
    });
};

/**
 * 404 - Not Found
 */
export const notFound = (
    res: Response,
    message: string = 'Không tìm thấy tài nguyên yêu cầu',
    message_en: string = 'Resource not found'
) => {
    return createResponse(res, 404, {
        message,
        message_en,
        status: 'fail'
    });
};

/**
 * 409 - Conflict
 */
export const conflict = (
    res: Response,
    message: string = 'Xung đột dữ liệu',
    message_en: string = 'Conflict',
    field?: string
) => {
    return createResponse(res, 409, {
        message,
        message_en,
        status: 'fail',
        violations: field ? [{
            message: { vi: message, en: message_en },
            type: 'Conflict',
            code: 409,
            field
        }] : undefined
    });
};

/**
 * 400 - Specific Validation Error from middleware
 */
export const validationError = (
    res: Response,
    violations: IViolation[]
) => {
    return createResponse(res, 400, {
        message: 'Lỗi xác thực dữ liệu',
        message_en: 'Data validation error',
        status: 'fail',
        violations
    });
};

/**
 * 500 - Internal Server Error (Used in global error handler)
 */
export const internalServerError = (
    res: Response,
    error?: any
) => {
    const isDev = process.env.NODE_ENV === 'development';
    console.error('SERVER ERROR:', error);

    return createResponse(res, 500, {
        message: 'Lỗi hệ thống, vui lòng thử lại sau',
        message_en: 'Internal server error',
        status: 'error',
        data: isDev ? { stack: error?.stack, details: error?.message } : null
    });
};

// Common error responses (Legacy compatibility)
export const invalidCredentialsError = (res: Response) => {
    return createResponse(res, 401, {
        message: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        message_en: 'Username or password is incorrect',
        status: 'fail',
        violations: [{
            message: {
                en: 'Username or password is incorrect',
                vi: 'Tên đăng nhập hoặc mật khẩu không chính xác'
            },
            type: 'InvalidCredentials',
            code: 401
        }]
    });
};

export const accountNotActiveError = (res: Response) => {
    return createResponse(res, 403, {
        message: 'Tài khoản chưa được kích hoạt',
        message_en: 'Account is not activated',
        status: 'fail',
        violations: [{
            message: {
                en: 'Account is not activated',
                vi: 'Tài khoản chưa được kích hoạt'
            },
            type: 'AccountNotActive',
            code: 403
        }]
    });
};

export const duplicateEntryError = (res: Response, field: string) => {
    const message = field === 'email'
        ? 'Email đã được sử dụng'
        : 'Tên đăng nhập đã được sử dụng';
    const message_en = field === 'email'
        ? 'Email is already in use'
        : 'Username is already taken';

    const violation: IViolation = {
        message: {
            en: message_en,
            vi: message
        },
        type: 'DuplicateEntry',
        code: 400,
        field
    };

    return createResponse(res, 400, {
        message,
        message_en,
        status: 'fail',
        violations: [violation]
    });
};

export const invalidOtpError = (res: Response) => {
    return createResponse(res, 400, {
        message: 'Mã OTP không hợp lệ hoặc đã hết hạn',
        message_en: 'Invalid or expired OTP',
        status: 'fail',
        violations: [{
            message: {
                en: 'Invalid or expired OTP',
                vi: 'Mã OTP không hợp lệ hoặc đã hết hạn'
            },
            type: 'InvalidOtp',
            code: 400
        }]
    });
};
