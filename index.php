<?php
/**
 * 安全教育互动影游网络版 — PHP 统一入口（路由）
 * Apache 将 /api 前缀请求重写至此文件，按路径分发到 api/ 业务模块。
 * 所有请求/响应均为 JSON；读 php://input 以兼容 sendBeacon 的 text/plain。
 */

require __DIR__ . '/config.php';

/* ---- 解析路由：去掉项目子目录前缀，只留 api/xxx 部分 ---- */
$uri  = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
$path = parse_url($uri, PHP_URL_PATH);
$base = rtrim(dirname($_SERVER['SCRIPT_NAME']), '/\\');   // 例如 /yingyou/anquan
if ($base !== '' && $base !== '/' && strpos($path, $base) === 0) {
    $path = substr($path, strlen($base));
}
$path = '/' . ltrim($path, '/');
$method = strtoupper(isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET');

require __DIR__ . '/api/helpers.php';

/* ---- 路由表 ----
   注意：键必须是「方法 + 单空格 + 路径」。不要为了视觉对齐在方法后补空格，
   否则 isset($routes[$key]) 永远匹配不上（曾导致所有 GET 接口 404）。 */
$routes = array(
    'POST /api/student/saveInfo'    => 'student_saveInfo',
    'POST /api/game/start'          => 'game_start',
    'POST /api/game/reportTrace'    => 'game_reportTrace',
    'POST /api/game/reportLoop'     => 'game_reportLoop',
    'POST /api/game/reportQte'      => 'game_reportQte',
    'POST /api/game/reportEnding'   => 'game_reportEnding',
    'POST /api/game/end'            => 'game_end',
    'POST /api/teacher/login'       => 'teacher_login',
    'GET /api/teacher/me'           => 'teacher_me',
    'GET /api/teacher/myClass'      => 'teacher_myClass',
    'GET /api/teacher/overview'     => 'teacher_overview',
    'GET /api/teacher/list'         => 'teacher_list',
    'POST /api/teacher/create'      => 'teacher_create',
    'POST /api/teacher/update'      => 'teacher_update',
    'POST /api/teacher/resetPassword' => 'teacher_resetPassword',
    'POST /api/teacher/delete'      => 'teacher_delete',
    'POST /api/class/create'        => 'class_create',
    'GET /api/student/unbindList'   => 'student_unbindList',
    'POST /api/class/addStudent'    => 'class_addStudent',
    'GET /api/class/rank'           => 'class_rank',
    'GET /api/class/studentDetail'  => 'class_studentDetail',
    'GET /api/class/export'         => 'class_export',
    'POST /api/class/delete'        => 'class_delete',
    'POST /api/class/removeStudent' => 'class_removeStudent',
    'POST /api/teacher/changePassword' => 'teacher_changePassword',
);

/* 归一化：多个空格/制表符折叠成单个空格，拼错也不会静默 404 */
$key = preg_replace('/\s+/', ' ', $method . ' ' . $path);
if (!isset($routes[$key])) {
    json_fail(404, '接口不存在: ' . $method . ' ' . $path);
}

require __DIR__ . '/api/student.php';
require __DIR__ . '/api/game.php';
require __DIR__ . '/api/teacher.php';

call_user_func($routes[$key]);
