Pod::Spec.new do |s|
  s.name           = 'OmpNative'
  s.version        = '1.0.0'
  s.summary        = 'OMP Mobile keychain and notification integration'
  s.description    = 'Stores paired machines and handles APNs registration and notification actions.'
  s.license        = { :type => 'MIT' }
  s.author         = 'OMP Mobile'
  s.homepage       = 'https://github.com/heyskylark/omp-mobile'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :path => '.' }
  s.static_framework = true
  s.source_files   = '**/*.swift'
  s.frameworks     = 'Security', 'UserNotifications', 'UIKit'
  s.dependency 'ExpoModulesCore'
end
