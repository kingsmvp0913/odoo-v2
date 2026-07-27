{
    'name': 'idxSSO免密登入',
    'summary': '平台簽發一次性 token，測試區免密登入',
    'description': '驗證平台 HMAC token 後建立已認證 session，不在測試區儲存平台密碼。',
    'author': 'IDX',
    'version': '1.0',
    'depends': ['web'],
    'installable': True,
    'application': False,
}
