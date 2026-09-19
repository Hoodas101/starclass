import request from '../request'

// 认证
export const login = (data) => request.post('/auth/login', data)
export const getProfile = () => request.get('/auth/getProfile')
export const changePassword = (data) => request.post('/auth/changePassword', data)

// 学员
export const getStudents = (params) => request.get('/students', { params })
export const getStudentOptions = (params) => request.get('/students/options', { params })
export const getStudentDetail = (id) => request.get(`/students/${id}`)
export const addStudent = (data) => request.post('/students', data)
export const updateStudent = (id, data) => request.put(`/students/${id}`, data)
export const deleteStudent = (id) => request.delete(`/students/${id}`)
export const importStudents = (data) => request.post('/students/import', data)

// 排课
export const getSchedules = (params) => request.get('/schedules', { params })
export const getScheduleOptions = (params) => request.get('/schedules/options', { params })
export const addSchedule = (data) => request.post('/schedules', data)
export const addRecursiveSchedule = (data) => request.post('/schedules/recursive', data)
export const updateSchedule = (id, data) => request.put(`/schedules/${id}`, data)
export const deleteSchedule = (id) => request.delete(`/schedules/${id}`)
export const getScheduleDetail = (id) => request.get(`/schedules/${id}`)
export const checkScheduleConflict = (data) => request.post('/schedules/conflict-check', data)

// 排课资源（教师 / 场地 / 活动）
export const getTeachers = (params) => request.get('/admin/teachers', { params })
export const getTeacherOptions = (params) => request.get('/admin/teachers/options', { params })
export const getStaffOptions = (params) => request.get('/admin/staff-options', { params })
export const addTeacher = (data) => request.post('/admin/teachers', data)
export const updateTeacher = (id, data) => request.put(`/admin/teachers/${id}`, data)
export const deleteTeacher = (id) => request.delete(`/admin/teachers/${id}`)
export const getClassrooms = (params) => request.get('/admin/classrooms', { params })
export const getCourses = (params) => request.get('/admin/courses', { params })
export const getCourseOptions = (params) => request.get('/admin/courses/options', { params })
export const addCourse = (data) => request.post('/admin/courses', data)
export const updateCourse = (id, data) => request.put(`/admin/courses/${id}`, data)
export const deleteCourse = (id) => request.delete(`/admin/courses/${id}`)

// 家长沟通
export const getParents = (params) => request.get('/admin/parents', { params })
export const sendMessage = (data) => request.post('/messages/send', data)

// 设置
export const getSettings = () => request.get('/settings')
export const saveSettings = (data) => request.put('/settings', data)

// 请假
export const getLeaves = (params) => request.get('/leave', { params })
export const approveLeave = (id, data) => request.put(`/leave/${id}/approve`, data)

// 反馈
export const getFeedback = (params) => request.get('/feedback', { params })
export const updateFeedbackStatus = (id, data) => request.put(`/feedback/${id}/status`, data)
export const replyFeedback = (id, data) => request.put(`/feedback/${id}/reply`, data)

// 签到
export const getCheckinRecords = (params) => request.get('/checkin/records', { params })
export const getCheckinToday = (params) => request.get('/checkin/today', { params })
export const checkinTeacher = (data) => request.post('/checkin/teacher', data)

// 上课记录 / 课时统计
export const getAttendances = (params) => request.get('/attendances', { params })
export const getAttendanceSummary = (params) => request.get('/attendances/summary', { params })
export const getStudentAttendances = (id, params) => request.get(`/attendances/student/${id}`, { params })

// 订单
export const getOrders = (params) => request.get('/orders', { params })
export const addOrder = (data) => request.post('/orders', data)
export const importOrders = (data) => request.post('/orders/import', data)
export const refundOrder = (id, data) => request.post(`/orders/${id}/refund`, data)
export const refundPreview = (id) => request.get(`/orders/${id}/refund-preview`)
export const payOrder = (id) => request.post(`/orders/${id}/pay`)
export const updateOrder = (id, data) => request.put(`/orders/${id}`, data)
export const cancelOrder = (id, data) => request.post(`/orders/${id}/cancel`, data)

// 积分
export const getPointsRanking = (params) => request.get('/points/ranking', { params })

// 会员卡
export const getExpiringCards = (params) => request.get('/membership/expiring', { params })
export const getCardTypes = (params) => request.get('/membership/card-types', { params })
export const addCardType = (data) => request.post('/membership/card-type', data)
export const updateCardType = (id, data) => request.put(`/membership/card-type/${id}`, data)
export const deleteCardType = (id) => request.delete(`/membership/card-type/${id}`)
export const pauseCard = (data) => request.post('/membership/pause', data)
export const resumeCard = (data) => request.post('/membership/resume', data)

// 管理
export const getDashboard = (params) => request.get('/admin/dashboard', { params })
export const getCharts = (params) => request.get('/admin/charts', { params })
export const getExport = (params) => request.get('/admin/export', { params })
// 操作日志（audit_log）只读查询：仅管理员可调用，用于事后追溯「谁在什么时候改了什么」
export const getAuditLogs = (params) => request.get('/admin/audit-logs', { params })
export const getCoachStats = (month) => request.get('/schedules/coach/stats', { params: month ? { month } : {} })
export const getAdminCoachStats = (month) => request.get('/schedules/admin/coach-stats', { params: month ? { month } : {} })
export const getOrderStats = () => request.get('/orders/stats')
export const getCoachClasses = (params) => request.get('/schedules/coach/classes', { params })
export const getAdminCoachClasses = (params) => request.get('/schedules/admin/coach-classes', { params })

// 薪资/课时费
export const getPayrollCoaches = (params) => request.get('/payroll/coaches', { params })
export const getPayrollCoachDetail = (id, params) => request.get(`/payroll/coach/${id}`, { params })
export const updatePayrollRule = (id, payRule) => request.put(`/payroll/coach/${id}/rule`, { payRule })
export const getMyPayroll = (params) => request.get('/payroll/me', { params })
// 按月结算（写入 payroll_logs，净利润随之扣减课酬）/ 结算记录 / 作废
export const settlePayroll = (month) => request.post('/payroll/settle', { month })
export const getPayrollLogs = (month) => request.get('/payroll/logs', { params: month ? { month } : {} })
export const voidPayrollLog = (id) => request.post(`/payroll/logs/${id}/void`)

// 训练点评
export const getComments = (params) => request.get('/comments', { params })
export const addComment = (data) => request.post('/comments', data)

// 通知（管理端）
export const getMyNotices = (params) => request.get('/notifications/list', { params })
export const getNoticeUnreadCount = () => request.get('/notifications/unread-count')
export const markNoticeRead = (data) => request.post('/notifications/read', data)
export const markAllNoticesRead = () => request.post('/notifications/read-all')
export const publishNotice = (data) => request.post('/notifications/create', data)
export const getNoticeAdminList = (params) => request.get('/notifications/admin/list', { params })
export const deleteNotice = (id) => request.delete(`/notifications/${id}`)
export const generateRenewalNotices = () => request.post('/notifications/generate-renewal')

// 增长中心
export const getGrowthFunnel = () => request.get('/growth/funnel')
export const getLeads = (params) => request.get('/growth/leads', { params })
export const addLead = (data) => request.post('/growth/leads', data)
export const updateLead = (id, data) => request.put(`/growth/leads/${id}`, data)
export const deleteLead = (id) => request.delete(`/growth/leads/${id}`)
export const convertLead = (id, data) => request.post(`/growth/leads/${id}/convert`, data)
export const setLeadStage = (id, data) => request.post(`/growth/leads/${id}/stage`, data)
export const getLeadSuggestions = (params) => request.get('/growth/suggestions', { params })
export const getLeadSuggestion = (id) => request.get(`/growth/leads/${id}/suggestion`)
export const getChurnList = () => request.get('/growth/churn')
export const getRenewalList = (params) => request.get('/growth/renewal', { params })
export const getLowClasses = (params) => request.get('/growth/low-classes', { params })
export const getReferrals = () => request.get('/growth/referrals')

// 试听预约（家长端提交，管理端处理）
export const getTrialList = (params) => request.get('/trial/list', { params })
export const applyTrial = (data) => request.post('/trial/apply', data)
export const updateTrial = (id, data) => request.put(`/trial/${id}`, data)

// 跟进任务（借鉴 trycompai/crm 的 Activity/AgentTask）
export const getFollowUps = (params) => request.get('/followups', { params })
export const getFollowUpsToday = () => request.get('/followups/today')
export const createFollowUp = (data) => request.post('/followups', data)
export const completeFollowUp = (id, data) => request.post(`/followups/${id}/complete`, data)
export const cancelFollowUp = (id) => request.post(`/followups/${id}/cancel`)
export const generateFollowUps = () => request.post('/followups/generate')

// 勿扰名单（借鉴 trycompai/crm 的 SuppressedContact）
export const getSuppressions = (params) => request.get('/admin/suppressions', { params })
export const addSuppression = (data) => request.post('/admin/suppressions', data)
export const deleteSuppression = (id) => request.delete(`/admin/suppressions/${id}`)

// 成员时间线（借鉴 trycompai/crm 的 Activity feed）
export const getStudentTimeline = (id) => request.get(`/students/${id}/timeline`)

// 积分管理（管理端）
export const getPointsSummary = () => request.get('/growth/points/summary')
export const getPointsList = (params) => request.get('/growth/points/list', { params })
export const getPointsLogs = (params) => request.get('/growth/points/logs', { params })
export const adjustPoints = (data) => request.post('/growth/points/adjust', data)
export const getPointsAdminRanking = (params) => request.get('/growth/points/ranking', { params })

// 补课/调课
export const getMakeupEligible = (params) => request.get('/makeup/eligible', { params })
export const assignMakeup = (data) => request.post('/makeup/assign', data)
export const cancelMakeup = (data) => request.post('/makeup/cancel', data)
export const getMakeupRecords = (params) => request.get('/makeup/records', { params })
export const rescheduleStudent = (data) => request.post('/makeup/reschedule', data)

// 财务报表
export const getFinanceSummary = (params) => request.get('/finance/summary', { params })
export const getFinanceMonthly = (params) => request.get('/finance/monthly', { params })
export const getFinanceByProduct = (params) => request.get('/finance/by-product', { params })
export const getFinanceBySales = (params) => request.get('/finance/by-sales', { params })

// 数据库备份
export const getBackups = () => request.get('/settings/backups')
export const createBackup = () => request.post('/settings/backups/create')
export const deleteBackup = (filename) => request.delete(`/settings/backups/${filename}`)

// 数据导入导出（JSON，可按模块）
export const getDataModules = () => request.get('/settings/data-modules')
export const exportData = (params) => request.get('/settings/export', { params, responseType: 'blob' })
export const importData = (payload, params) => request.post('/settings/import', payload, { params })
